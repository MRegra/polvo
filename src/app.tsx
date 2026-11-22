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
import { SYSTEM_PROMPT } from './config.js';
import Image from 'ink-picture';
import { fileURLToPath } from 'node:url';
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
}
interface ViewportLine {
  text: string;
  color: string;
  bold?: boolean;
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
function estimateTokens(text: string): number {
  return Math.floor(text.trim().length / 4);
}
const CONTEXT_WINDOW_TOKENS = 200_000;
function estimateHistoryTokens(history: Message[]): number {
  let total = 0;
  for (const msg of history) {
    total += estimateTokens(msg.content);
  }
  return total;
}
function compactHistory(
  history: Message[],
  maxTokens: number = CONTEXT_WINDOW_TOKENS,
): Message[] {
  let totalTokens = 0;
  for (const msg of history) {
    totalTokens += estimateTokens(msg.content);
  }
  if (totalTokens <= maxTokens) {
    return history;
  }
  const result: Message[] = [];
  let currentTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const msgTokens = estimateTokens(msg.content);
    if (msg.role === 'system') {
      result.unshift(msg);
      currentTokens += msgTokens;
      continue;
    }
    if (currentTokens + msgTokens <= maxTokens) {
      result.unshift(msg);
      currentTokens += msgTokens;
    }
  }
  return result;
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
function wrapLine(text: string, width: number): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) {
    return [''];
  }
  const result: string[] = [];
  let line = '';
  let cells = 0;
  for (const char of chars) {
    const charWidth = getCharWidth(char);
    if (cells + charWidth > width && line.length > 0) {
      result.push(line);
      line = '';
      cells = 0;
    }
    line += char;
    cells += charWidth;
  }
  if (line.length > 0) {
    result.push(line);
  }
  return result;
}
/**
 * Convert conversation turns into a flat array of display lines.
 * This is the source of truth for viewport height and scroll position.
 */
function buildViewportLines(
  turns: Turn[],
  width: number,
): ViewportLine[] {
  const lines: ViewportLine[] = [];
  const add = (
    content: string,
    color: string,
    bold = false,
  ): void => {
    for (const rawLine of content.split(/\r?\n/)) {
      const clean = sanitizeText(rawLine);
      for (const wrapped of wrapLine(clean, width)) {
        lines.push({
          text: wrapped,
          color,
          bold,
        });
      }
    }
  };
  for (const turn of turns) {
    switch (turn.role) {
      case 'header':
        add(turn.content, 'magenta', true);
        break;
      case 'system':
        add(turn.content, 'yellow');
        break;
      case 'user':
        add('you:', 'cyan', true);
        add(turn.content, 'white');
        break;
      case 'assistant':
        add('🐙 polvo:', 'green', true);
        add(
          turn.content || (turn.streaming ? '…' : ''),
          'white',
        );
        break;
      case 'tool-call':
        add(`🔧 ${turn.content}`, 'blueBright');
        break;
      case 'tool-result':
        add(
          `✓ ${turn.content}`,
          turn.error ? 'red' : 'gray',
        );
        break;
    }
    // Spacing between conversation turns.
    lines.push({
      text: '',
      color: 'white',
    });
  }
  return lines;
}


const octopusImage = fileURLToPath(
  new URL('../assets/polvo-octopus-pink.png', import.meta.url)
);

function OctopusLogo(): React.ReactElement {
  return (
    <Box flexShrink={0}>
      <Image
        src={octopusImage}
        width={14}
        height={6}
        objectFit="contain"
        alt="Polvo octopus mascot"
      />
    </Box>
  );
}

function BrandHeader({
  provider,
}: {
  provider: Provider;
}): React.ReactElement {
  const version = '0.3.15';
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
  useEffect(() => {
    let count = estimateTokens(SYSTEM_PROMPT);
    for (const msg of history.current) {
      count += estimateTokens(msg.content);
    }
    setContextTokenCount(count);
  }, [turns]);
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
        content: text,
      });
      if (
        estimateHistoryTokens(history.current) >
        CONTEXT_WINDOW_TOKENS * 0.9
      ) {
        history.current = compactHistory(
          history.current,
        ) as Message[];
      }
      const events: AgentEvents = {
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
        confirm,
      };
      try {
        await runAgent(
          provider,
          history.current,
          events,
          controller.signal,
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
          <Text
            key={viewportStart + index}
            color={line.color}
            bold={line.bold}
          >
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      {/* History indicator */}
      {isBrowsingHistory ? (
        <Box
          flexShrink={0}
          paddingX={1}
        >
          <Text color="yellow" dimColor>
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
        maxTokens={CONTEXT_WINDOW_TOKENS}
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
}
function StatusBar({
  tokenCount,
  maxTokens,
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
        <Text color="white" dimColor>
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
          context: {tokenCount}/{maxTokens} ({tokenK}k/{maxK}k)
        </Text>
      </Box>
    </Box>
  );
}
// -----------------------------------------------------------
// Approval prompt
// -----------------------------------------------------------
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
            <Text color="gray">
              ({content.length} chars, {lines.length} line
              {lines.length === 1 ? '' : 's'})
            </Text>
          </Text>
          {preview.map((line, i) => (
            <Text key={i} color="gray">
              │ {line}
            </Text>
          ))}
          {lines.length > preview.length ? (
            <Text color="gray">
              │ … (+{lines.length - preview.length} more)
            </Text>
          ) : null}
        </Box>
      ) : (
        <Text color="gray">
          {sanitize(JSON.stringify(pending.args)).slice(0, 300)}
        </Text>
      )}
      <Text>
        apply?{' '}
        <Text color="greenBright" bold>
          y
        </Text>
        <Text color="gray"> = yes · </Text>
        <Text color="red" bold>
          n
        </Text>
        <Text color="gray">
          {' '}= no · Esc = cancel turn
        </Text>
      </Text>
    </Box>
  );
}