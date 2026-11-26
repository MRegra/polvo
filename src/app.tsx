import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Box,
  Text,
  useApp,
  useInput,
  useStdin,
} from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { AgentEvents } from './agent.js';
import { runAgent } from './agent.js';
import type { Message, Provider } from './provider.js';
import { normalize } from 'node:path';
import { SYSTEM_PROMPT, type Config } from './config.js';
import { estimateMessages, estimateTokens } from './context.js';
import { parseCommand } from './command.js';
import { VERSION } from './version.js';

// Explicit hex colors: ANSI 'gray' and dimColor (faint) are nearly invisible
// on many dark terminal themes.
const MUTED = '#A0A8B4';
const CODE = '#E5C07B';
type Role =
  | 'header'
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result';
interface Turn {
  role: Role;
  content: string;
  streaming?: boolean;
  error?: boolean;
}
interface PendingApproval {
  tool: string;
  args: Record<string, unknown>;
}
interface Props {
  provider: Provider;
  warning?: string | null;
  config: Pick<Config, 'maxSteps' | 'checks' | 'maxFixAttempts'> & { system?: string };
}
interface ViewportSegment {
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
}

interface ViewportLine {
  segments: ViewportSegment[];
}

function compactArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
function summarize(result: string): string {
  const lines = result.split('\n').length;
  return `→ ${lines} line${lines === 1 ? '' : 's'}, ${result.length} chars`;
}
function sanitize(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
}
function sanitizeText(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, '');
}
function sanitizePromptInput(s: string): string {
  return s
    // Remove SGR mouse reports, whether Ink preserved ESC or not.
    .replace(/(?:\u001b)?\[?<\d+;\d+;\d+[mM]/g, '')
    // Keep the prompt single-line.
    .replace(/[\r\n]+/g, ' ');
}
function dropIncompleteTail(history: Message[]): void {
  let i = history.length - 1;
  let toolResults = 0;
  while (i >= 0 && history[i]?.role === 'tool') {
    toolResults++;
    i--;
  }
  const last = history[i];
  if (
    last &&
    last.role === 'assistant' &&
    last.tool_calls &&
    last.tool_calls.length > toolResults
  ) {
    history.length = i;
  }
}
/**
 * Approximate terminal display width for a Unicode character.
 * Most characters occupy one cell; East Asian wide characters and
 * common emoji occupy two.
 */
function getCharWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff);
  return wide ? 2 : 1;
}
/**
 * Wrap one logical line into terminal-width-aware display lines.
 */
function parseInlineMarkdown(
  input: string,
  color: string,
  forceBold = false,
): ViewportSegment[] {
  const result: ViewportSegment[] = [];
  const regex = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const add = (text: string, style: Partial<ViewportSegment> = {}): void => {
    if (!text) return;
    result.push({
      text,
      color,
      bold: forceBold || style.bold,
      italic: style.italic,
    });
  };

  while ((match = regex.exec(input)) !== null) {
    add(input.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith('**') || token.startsWith('__')) {
      add(token.slice(2, -2), { bold: true });
    } else if (token.startsWith('`')) {
      result.push({ text: token.slice(1, -1), color: CODE });
    } else {
      add(token.slice(1, -1), { italic: true });
    }

    lastIndex = regex.lastIndex;
  }

  add(input.slice(lastIndex));
  return result;
}

function pushStyledSegment(
  line: ViewportSegment[],
  text: string,
  style: ViewportSegment,
): void {
  if (!text) return;
  const previous = line[line.length - 1];

  if (
    previous &&
    previous.color === style.color &&
    previous.bold === style.bold &&
    previous.italic === style.italic
  ) {
    previous.text += text;
  } else {
    line.push({ ...style, text });
  }
}

function wrapStyledSegments(
  segments: ViewportSegment[],
  width: number,
): ViewportLine[] {
  const result: ViewportLine[] = [];
  let current: ViewportSegment[] = [];
  let cells = 0;

  const flush = (): void => {
    result.push({ segments: current });
    current = [];
    cells = 0;
  };

  for (const segment of segments) {
    for (const char of Array.from(segment.text)) {
      const charWidth = getCharWidth(char);
      if (cells + charWidth > width && cells > 0) flush();
      pushStyledSegment(current, char, segment);
      cells += charWidth;
    }
  }

  if (current.length > 0 || result.length === 0) flush();
  return result;
}

/**
 * Convert turns into styled terminal lines. Formatting stays attached
 * to segments while the viewport scrolls over the flattened line list.
 */
function buildViewportLines(
  turns: Turn[],
  width: number,
): ViewportLine[] {
  const lines: ViewportLine[] = [];

  const addPlain = (
    content: string,
    color: string,
    bold = false,
  ): void => {
    for (const raw of content.split(/\r?\n/)) {
      lines.push(
        ...wrapStyledSegments(
          [{ text: sanitizeText(raw), color, bold }],
          width,
        ),
      );
    }
  };

  const addMarkdown = (content: string, color = 'white'): void => {
    let inCodeBlock = false;

    for (const raw of content.split(/\r?\n/)) {
      if (/^\s*```/.test(raw)) {
        inCodeBlock = !inCodeBlock;
        continue;
      }

      const clean = sanitizeText(raw);
      if (inCodeBlock) {
        lines.push(
          ...wrapStyledSegments([{ text: clean, color: MUTED }], width),
        );
        continue;
      }

      const heading = clean.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      const text = heading ? heading[1] : clean;
      lines.push(
        ...wrapStyledSegments(
          parseInlineMarkdown(text, color, Boolean(heading)),
          width,
        ),
      );
    }
  };

  for (const turn of turns) {
    switch (turn.role) {
      case 'header':
        addPlain(turn.content, 'magenta', true);
        break;
      case 'system':
        addMarkdown(turn.content, turn.error ? 'red' : 'yellow');
        break;
      case 'user':
        addPlain('you:', 'cyan', true);
        addMarkdown(turn.content);
        break;
      case 'assistant':
        addPlain('🐙 polvo:', 'green', true);
        addMarkdown(turn.content || (turn.streaming ? '…' : ''));
        break;
      case 'tool-call':
        addPlain(`🔧 ${turn.content}`, 'blueBright');
        break;
      case 'tool-result':
        addMarkdown(`✓ ${turn.content}`, turn.error ? 'red' : MUTED);
        break;
    }

    lines.push({ segments: [{ text: ' ', color: 'white' }] });
  }

  return lines;
}


/**
 * Hand-drawn logo, rendered two pixels per cell with half blocks (▀ ▄).
 * '.' = transparent, P = pink, W = white, K = pupil. Keep the row count even.
 */
const OCTOPUS = [
  '....PPPPPP....',
  '..PPPPPPPPPP..',
  '.PPPPPPPPPPPP.',
  '.PPWWPPPPWWPP.',
  '.PPWKPPPPWKPP.',
  '.PPPPPPPPPPPP.',
  '..PPPPPPPPPP..',
  '.PPPPPPPPPPPP.',
  '.PP.PP..PP.PP.',
  'PP..PP..PP..PP',
  'P..PP....PP..P',
  '.PP........PP.',
];

const OCTOPUS_COLORS: Record<string, string | undefined> = {
  P: '#FF75A8',
  W: '#FFFFFF',
  K: '#1E1E28',
};

function OctopusLogo(): React.ReactElement {
  const rows = Array.from({ length: OCTOPUS.length / 2 }, (_, i) => i * 2);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((y) => (
        <Text key={y}>
          {[...OCTOPUS[y]].map((topKey, x) => {
            const top = OCTOPUS_COLORS[topKey];
            const bottom = OCTOPUS_COLORS[OCTOPUS[y + 1][x]];
            if (!top && !bottom) return <Text key={x}> </Text>;
            if (!top) {
              return (
                <Text key={x} color={bottom}>
                  ▄
                </Text>
              );
            }
            return (
              <Text key={x} color={top} backgroundColor={bottom}>
                ▀
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

function BrandHeader({
  provider,
}: {
  provider: Provider;
}): React.ReactElement {
  const version = VERSION;
  const home = process.env.HOME ?? '';
  const cwd = process.cwd();
  const displayPath =
    home && cwd.startsWith(home)
      ? `~${cwd.slice(home.length)}`
      : cwd;
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      paddingX={2}
      paddingY={1}
      gap={3}
      flexShrink={0}
    >
      <OctopusLogo />
      <Box
        flexDirection="column"
        justifyContent="center"
        flexShrink={1}
      >
        <Text color="white" bold>
          Polvo <Text color="#9299A3">v{version}</Text>
        </Text>
        <Text color="#D1D5DB">
          {provider.model}
        </Text>
        <Text color="#9299A3">
          {displayPath}
        </Text>
      </Box>
    </Box>
  );
}
export function App({
  provider,
  warning,
  config,
}: Props): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [turns, setTurns] = useState<Turn[]>(() => {
    const seed: Turn[] = [];
    if (warning) {
      seed.push({
        role: 'system',
        content: sanitizeText(warning),
      });
    }
    return seed;
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] =
    useState<PendingApproval | null>(null);
  // Zero means following the latest conversation output.
  // Positive values represent lines scrolled back from the bottom.
  const [scrollOffset, setScrollOffset] = useState(0);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const resolvePendingRef =
    useRef<((approved: boolean) => void) | null>(null);
  const pendingSinceRef = useRef(0);
  const history = useRef<Message[]>([]);
  const [contextTokenCount, setContextTokenCount] =
    useState(0);
  const [tokPerS, setTokPerS] = useState<number | null>(null);
  useEffect(() => {
    setContextTokenCount(
      estimateTokens(config.system ?? SYSTEM_PROMPT) + estimateMessages(history.current),
    );
  }, [turns, config.system]);
  const resolvePending = useCallback(
    (approved: boolean): void => {
      const resolve = resolvePendingRef.current;
      resolvePendingRef.current = null;
      setPending(null);
      resolve?.(approved);
    },
    [],
  );
  // ---------------------------------------------------------
  // Terminal resize and viewport calculations
  // ---------------------------------------------------------
  const [, bumpResize] = useState(0);
  useEffect(() => {
    const onResize = (): void => {
      bumpResize((n) => n + 1);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  const rows = process.stdout.rows ?? 24;
  const columns = process.stdout.columns ?? 80;
  // Input, status bar and optional activity indicator.
  const fixedRows = 11 + (pending || busy ? 1 : 0);
  const indicatorRows = scrollOffset > 0 ? 1 : 0;
  const viewportHeight = Math.max(
    1,
    rows - fixedRows - indicatorRows,
  );
  const viewportLines = useMemo(
    () =>
      buildViewportLines(
        turns,
        Math.max(10, columns - 2),
      ),
    [turns, columns],
  );
  const maxScrollOffset = Math.max(
    0,
    viewportLines.length - viewportHeight,
  );
  const effectiveScrollOffset = Math.min(
    scrollOffset,
    maxScrollOffset,
  );
  const viewportEnd = Math.max(
    0,
    viewportLines.length - effectiveScrollOffset,
  );
  const viewportStart = Math.max(
    0,
    viewportEnd - viewportHeight,
  );
  const visibleLines = viewportLines.slice(
    viewportStart,
    viewportEnd,
  );
  const isBrowsingHistory = effectiveScrollOffset > 0;
  const maxScrollRef = useRef(maxScrollOffset);
  maxScrollRef.current = maxScrollOffset;
  // ---------------------------------------------------------
  // Keyboard scrolling and approval handling
  // ---------------------------------------------------------
  useInput(
    (inputChar, key) => {
      if (resolvePendingRef.current) {
        if (
          Date.now() - pendingSinceRef.current < 350
        ) {
          return;
        }
        if (key.ctrl || key.meta) return;
        const ch = inputChar.toLowerCase();
        if (ch === 'y') {
          resolvePending(true);
        } else if (ch === 'n') {
          resolvePending(false);
        } else if (key.escape) {
          resolvePending(false);
          abortRef.current?.abort();
        }
        return;
      }
      if (key.escape) {
        abortRef.current?.abort();
        return;
      }
      // Keep ordinary text input unaffected.
      if (input.length !== 0) return;
      const pageSize = Math.max(
        1,
        viewportHeight - 2,
      );
      if (
        key.pageUp ||
        (key.ctrl && inputChar.toLowerCase() === 'u')
      ) {
        setScrollOffset((current) =>
          Math.min(
            maxScrollRef.current,
            current + pageSize,
          ),
        );
      } else if (
        key.pageDown ||
        (key.ctrl && inputChar.toLowerCase() === 'd')
      ) {
        setScrollOffset((current) =>
          Math.max(0, current - pageSize),
        );
      } else if (key.upArrow) {
        setScrollOffset((current) =>
          Math.min(maxScrollRef.current, current + 1),
        );
      } else if (key.downArrow) {
        setScrollOffset((current) =>
          Math.max(0, current - 1),
        );
      }
    },
    {
      isActive: isRawModeSupported,
    },
  );
  // ---------------------------------------------------------
  // SGR mouse-wheel scrolling
  // ---------------------------------------------------------
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }
    // Enable basic mouse reporting and SGR coordinates.
    const enableMouse =
      '\u001b[?1000h\u001b[?1006h';
    const disableMouse =
      '\u001b[?1000l\u001b[?1006l';
    let buffer = '';
    process.stdout.write(enableMouse);
    const onData = (chunk: Buffer | string): void => {
      buffer +=
        typeof chunk === 'string'
          ? chunk
          : chunk.toString('utf8');
      const eventPattern =
        /\u001b\[<(\d+);\d+;\d+[mM]/g;
      let match: RegExpExecArray | null;
      let consumed = 0;
      while (
        (match = eventPattern.exec(buffer)) !== null
      ) {
        consumed = eventPattern.lastIndex;
        const button = Number(match[1]);
        // SGR button 64 = wheel up.
        if (button === 64) {
          setScrollOffset((current) =>
            Math.min(
              maxScrollRef.current,
              current + 3,
            ),
          );
        }
        // SGR button 65 = wheel down.
        if (button === 65) {
          setScrollOffset((current) =>
            Math.max(0, current - 3),
          );
        }
      }
      if (consumed > 0) {
        buffer = buffer.slice(consumed);
      }
      // Preserve a potentially incomplete escape sequence.
      const lastEscape = buffer.lastIndexOf('\u001b');
      buffer =
        lastEscape >= 0
          ? buffer.slice(lastEscape)
          : '';
      if (buffer.length > 32) {
        buffer = '';
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
      process.stdout.write(disableMouse);
    };
  }, []);
  // ---------------------------------------------------------
  // Agent output handling
  // ---------------------------------------------------------
  const appendText = useCallback(
    (delta: string): void => {
      const cleanDelta = sanitizeText(delta);
      setTurns((prev) => {
        const last = prev[prev.length - 1];
        if (
          last?.role === 'assistant' &&
          last.streaming
        ) {
          const next = [...prev];
          next[next.length - 1] = {
            ...last,
            content: last.content + cleanDelta,
          };
          return next;
        }
        return [
          ...prev,
          {
            role: 'assistant',
            content: cleanDelta,
            streaming: true,
          },
        ];
      });
    },
    [],
  );
  const finalizeAssistant = useCallback(
    (): void => {
      setTurns((prev) => {
        const last = prev[prev.length - 1];
        if (
          last?.role === 'assistant' &&
          last.streaming
        ) {
          if (last.content === '') {
            return prev.slice(0, -1);
          }
          const next = [...prev];
          next[next.length - 1] = {
            ...last,
            streaming: false,
          };
          return next;
        }
        return prev;
      });
    },
    [],
  );
  const confirm = useCallback(
    (req: {
      tool: string;
      args: Record<string, unknown>;
    }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        pendingSinceRef.current = Date.now();
        setPending({
          tool: req.tool,
          args: req.args,
        });
        resolvePendingRef.current = resolve;
      }),
    [],
  );
  // ---------------------------------------------------------
  // User input and agent execution
  // ---------------------------------------------------------
  const onSubmit = useCallback(
    async (raw: string): Promise<void> => {
      if (busyRef.current) return;
      const text = sanitizeText(raw.trim());
      setInput('');
      if (text === '') return;
      // A new prompt returns the viewport to the bottom.
      setScrollOffset(0);
      if (text === '/exit' || text === '/quit') {
        exit();
        return;
      }
      // /plan <task>: read-only turn — the harness withholds every tool that
      // changes state, so the model can only explore and propose.
      const planMatch = /^\/plan(?:\s+(.*))?$/.exec(text);
      if (planMatch && !planMatch[1]?.trim()) {
        setTurns((prev) => [
          ...prev,
          { role: 'system', content: 'usage: /plan <what you want to build or change>' },
        ]);
        return;
      }
      const readOnly = planMatch !== null;
      const prompt = readOnly
        ? `Plan only — do not change anything yet. Explore what you need, then reply with a short numbered plan (files to touch, steps, how to verify) for: ${planMatch[1]!.trim()}`
        : text;
      busyRef.current = true;
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      setTurns((prev) => [
        ...prev,
        {
          role: 'user',
          content: text,
        },
      ]);
      history.current.push({
        role: 'user',
        content: prompt,
      });
      const notice = (content: string, error = false): void => {
        finalizeAssistant();
        setTurns((prev) => [
          ...prev,
          { role: 'system', content: sanitizeText(content), error },
        ]);
      };
      const events: AgentEvents = {
        onNotice: (t) => notice(`· ${t}`),
        onCheck: (r) =>
          notice(
            r.ok
              ? `✓ check passed: ${r.command}`
              : `✗ check failed: ${r.command} (exit ${r.exitCode ?? 'killed'}) — sent to the model`,
            !r.ok,
          ),
        onText: appendText,
        onToolCall: (name, args) => {
          finalizeAssistant();
          setTurns((prev) => [
            ...prev,
            {
              role: 'tool-call',
              content: sanitizeText(
                `${name}(${compactArgs(args)})`,
              ),
            },
          ]);
        },
        onToolResult: (_name, result, isError) => {
          const safeResult = isError
            ? result
            : summarize(result);
          setTurns((prev) => [
            ...prev,
            {
              role: 'tool-result',
              content: sanitizeText(safeResult),
              error: isError,
            },
          ]);
        },
        onUsage: (u) => {
          if (u.evalMs > 0) setTokPerS(Number(((u.outputTokens / u.evalMs) * 1000).toFixed(1)));
        },
        confirm,
      };
      try {
        await runAgent(
          provider,
          history.current,
          events,
          controller.signal,
          {
            maxSteps: config.maxSteps,
            contextTokens: provider.contextTokens,
            checks: config.checks,
            maxFixAttempts: config.maxFixAttempts,
            readOnly,
          },
        );
        finalizeAssistant();
        if (controller.signal.aborted) {
          dropIncompleteTail(history.current);
          setTurns((prev) => [
            ...prev,
            {
              role: 'system',
              content: sanitizeText('[cancelled]'),
            },
          ]);
        }
      } catch (err) {
        finalizeAssistant();
        dropIncompleteTail(history.current);
        const msg =
          err instanceof Error
            ? err.message
            : String(err);
        setTurns((prev) => [
          ...prev,
          {
            role: 'system',
            content: sanitizeText(`⚠ ${msg}`),
          },
        ]);
      } finally {
        if (resolvePendingRef.current) {
          resolvePending(false);
        }
        abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    },
    [
      provider,
      config,
      exit,
      appendText,
      finalizeAssistant,
      confirm,
      resolvePending,
    ],
  );
  // ---------------------------------------------------------
  // UI
  // ---------------------------------------------------------
  return (
    <Box
      flexDirection="column"
      height={rows}
    >
      <BrandHeader provider={provider} />
      {/* Conversation viewport */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        height={viewportHeight}
        overflow="hidden"
      >
        {visibleLines.map((line, index) => (
          <Text key={viewportStart + index}>
            {line.segments.map((segment, segmentIndex) => (
              <Text
                key={segmentIndex}
                color={segment.color}
                bold={segment.bold}
                italic={segment.italic}
              >
                {segment.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      {/* History indicator */}
      {isBrowsingHistory ? (
        <Box
          flexShrink={0}
          paddingX={1}
        >
          <Text color="yellow">
            ↑ Browsing history · PageUp/PageDown · ↓ to return
          </Text>
        </Box>
      ) : null}
      {/* Approval and activity indicators */}
      {pending ? (
        <Box
          flexShrink={0}
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
        >
          <ApprovalPrompt pending={pending} />
        </Box>
      ) : busy ? (
        <Box
          flexShrink={0}
          paddingX={1}
        >
          <Text color="cyanBright">
            <Spinner type="dots" /> thinking…
          </Text>
        </Box>
      ) : null}
      {/* Input */}
      <Box
        flexShrink={0}
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
        <Box>
          <Text color="cyan">❯ </Text>
          <TextInput
            value={input}
            onChange={(v) =>
              setInput(sanitizePromptInput(v))
            }
            onSubmit={onSubmit}
            placeholder="type a message · /exit to quit"
          />
        </Box>
      </Box>
      {/* Context status */}
      <StatusBar
        tokenCount={contextTokenCount}
        maxTokens={provider.contextTokens}
        tokPerS={tokPerS}
      />
    </Box>
  );
}
// -----------------------------------------------------------
// Status bar
// -----------------------------------------------------------
interface StatusBarProps {
  tokenCount: number;
  maxTokens: number;
  tokPerS: number | null;
}
function StatusBar({
  tokenCount,
  maxTokens,
  tokPerS,
}: StatusBarProps): React.ReactElement {
  const tokenK = Math.floor(tokenCount / 1000);
  const maxK = Math.floor(maxTokens / 1000);
  const percentage = Math.min(
    100,
    Math.floor((tokenCount / maxTokens) * 100),
  );
  return (
    <Box
      flexShrink={0}
      paddingX={1}
      paddingY={0}
    >
      <Box
        flexDirection="row"
        justifyContent="space-between"
        width="100%"
      >
        <Text color={MUTED}>
          {process.cwd()}
        </Text>
        <Text
          color={
            percentage > 80
              ? 'yellow'
              : percentage > 60
                ? 'cyan'
                : 'white'
          }
        >
          context: {tokenCount}/{maxTokens} ({tokenK}k/{maxK}k){tokPerS !== null ? ` · ${tokPerS} tok/s` : ''}
        </Text>
      </Box>
    </Box>
  );
}
// -----------------------------------------------------------
// Approval prompt
// -----------------------------------------------------------
/**
 * The command exactly as it will run: parsed argv, each argument quoted if it
 * isn't plain, never truncated silently — so padding or a long argument can't
 * hide what follows from the approval prompt.
 */
function commandPreview(command: unknown): string {
  let argv: string[];
  try {
    argv = parseCommand(String(command ?? ''));
  } catch (err) {
    return `(will fail: ${err instanceof Error ? err.message : String(err)})`;
  }
  const shown = argv
    .map((a) => (/^[\w./:=@%+,-]+$/.test(a) ? a : JSON.stringify(a)))
    .join(' ');
  const safe = sanitize(shown);
  const LIMIT = 2_000;
  return safe.length <= LIMIT
    ? safe
    : `${safe.slice(0, LIMIT)} … [${safe.length - LIMIT} more chars not shown — answer n]`;
}

const DIFF_LINES = 10;

/** old_string as red "-" lines, new_string as green "+" lines, each capped. */
function EditPreview({
  args,
  path,
}: {
  args: Record<string, unknown>;
  path: string;
}): React.ReactElement {
  const side = (value: unknown): string[] =>
    (typeof value === 'string' ? value : '').split('\n');
  const render = (lines: string[], sign: '-' | '+'): React.ReactElement[] => {
    const shown = lines.slice(0, DIFF_LINES).map((line, i) => (
      <Text key={`${sign}${i}`} color={sign === '-' ? '#F87171' : '#4ADE80'}>
        {sign} {sanitize(line.slice(0, 500)).slice(0, 200)}
      </Text>
    ));
    if (lines.length > DIFF_LINES) {
      shown.push(
        <Text key={`${sign}more`} color={MUTED}>
          {sign} … (+{lines.length - DIFF_LINES} more lines)
        </Text>,
      );
    }
    return shown;
  };
  return (
    <Box flexDirection="column">
      <Text color="white">
        {path}
        {args.replace_all === true ? (
          <Text color={MUTED}> (every occurrence)</Text>
        ) : null}
      </Text>
      {render(side(args.old_string), '-')}
      {render(side(args.new_string), '+')}
    </Box>
  );
}

function ApprovalPrompt({
  pending,
}: {
  pending: PendingApproval;
}): React.ReactElement {
  const rawPath =
    typeof pending.args.path === 'string'
      ? pending.args.path
      : '?';
  const path = sanitize(normalize(rawPath));
  const content =
    typeof pending.args.content === 'string'
      ? pending.args.content
      : '';
  const lines = content.split('\n');
  const preview = lines
    .slice(0, 8)
    .map((line) =>
      sanitize(line.slice(0, 500)).slice(0, 200),
    );
  return (
    <Box flexDirection="column">
      <Text color="yellowBright" bold>
        🔐 polvo wants to {pending.tool.replace(/_/g, ' ')}
      </Text>
      {pending.tool === 'write_file' ? (
        <Box flexDirection="column">
          <Text color="white">
            {path}{' '}
            <Text color={MUTED}>
              ({content.length} chars, {lines.length} line
              {lines.length === 1 ? '' : 's'})
            </Text>
          </Text>
          {preview.map((line, i) => (
            <Text key={i} color={MUTED}>
              │ {line}
            </Text>
          ))}
          {lines.length > preview.length ? (
            <Text color={MUTED}>
              │ … (+{lines.length - preview.length} more)
            </Text>
          ) : null}
        </Box>
      ) : pending.tool === 'edit_file' ? (
        <EditPreview args={pending.args} path={path} />
      ) : pending.tool === 'run_command' ? (
        <Text color="white">$ {commandPreview(pending.args.command)}</Text>
      ) : pending.tool === 'run_checks' ? (
        <Box flexDirection="column">
          <Text color={MUTED}>
            project checks from .polvo.json (approve once per session):
          </Text>
          {(Array.isArray(pending.args.commands) ? pending.args.commands : []).map(
            (c, i) => (
              <Text key={i} color="white">
                $ {sanitize(String(c)).slice(0, 200)}
              </Text>
            ),
          )}
        </Box>
      ) : (
        <Text color={MUTED}>
          {sanitize(JSON.stringify(pending.args)).slice(0, 300)}
        </Text>
      )}
      <Text>
        {pending.tool === 'run_checks' || pending.tool === 'run_command' ? 'run?' : 'apply?'}{' '}
        <Text color="greenBright" bold>
          y
        </Text>
        <Text color={MUTED}> = yes · </Text>
        <Text color="red" bold>
          n
        </Text>
        <Text color={MUTED}>
          {' '}= no · Esc = cancel turn
        </Text>
      </Text>
    </Box>
  );
}