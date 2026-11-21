import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { AgentEvents } from './agent.js';
import { runAgent } from './agent.js';
import type { Message, Provider } from './provider.js';
import { normalize } from 'node:path';

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
  streaming?: boolean; // an assistant turn still being written
  error?: boolean; // a failed tool result
}

interface PendingApproval {
  tool: string;
  args: Record<string, unknown>;
}

interface Props {
  provider: Provider;
  warning?: string | null;
}

function compactArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function summarize(result: string): string {
  const lines = result.split('\n').length;
  return `→ ${lines} line${lines === 1 ? '' : 's'}, ${result.length} chars`;
}

// Strip control characters (incl. ESC) so a model-supplied path or file preview
// can't use ANSI escapes to conceal or spoof what the approval prompt shows.
function sanitize(s: string): string {
  // control chars (incl. ESC), Unicode format/bidi chars (RTL override,
  // zero-width), and line/paragraph separators — all can conceal or reorder.
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
}

// Sanitize text for display: remove control chars that can mess with the
// terminal (ANSI escapes, bidi overrides, zero-width chars) but preserve
// tab and newline so the text remains readable. Carriage returns are removed
// because they can cause text to overwrite itself in the terminal.
function sanitizeText(s: string): string {
  // Remove all control characters except tab (U+0009) and newline (U+000A).
  // This catches ESC (U+001B, start of ANSI codes), carriage return (U+000D),
  // and all other C0/C1 controls that could alter terminal behavior.
  // Then remove Unicode format/bidi/zero-width chars that can conceal or reorder.
  return s
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, '');
}

// After an abort or error, keep every COMPLETED step (tool side effects really
// happened and the model should remember them) but drop a trailing assistant
// whose tool calls were left unanswered, so the next request stays valid.
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
 * The whole polvo UI. The app fills the terminal height: the conversation is
 * bottom-aligned (newest turns above the input, older scroll off the top) and
 * the input box is pinned to the bottom. All turns — user, assistant, tool
 * calls and tool results — live in one `turns` list; the in-progress assistant
 * reply is the last turn with `streaming: true`. `history` is the parallel
 * message list the agent loop sends to the model.
 */
export function App({ provider, warning }: Props): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();

  const [turns, setTurns] = useState<Turn[]>(() => {
    const seed: Turn[] = [
      { role: 'header', content: sanitizeText(`🐙 polvo v0.3.3 · model: ${provider.model}`) },
    ];
    if (warning) seed.push({ role: 'system', content: sanitizeText(warning) });
    return seed;
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);

  const busyRef = useRef(false); // authoritative re-entrancy guard
  const abortRef = useRef<AbortController | null>(null);
  const resolvePendingRef = useRef<((approved: boolean) => void) | null>(null);
  const pendingSinceRef = useRef(0); // when the current prompt appeared (type-ahead guard)
  const history = useRef<Message[]>([]); // user/assistant/tool messages for the model

  const resolvePending = useCallback((approved: boolean): void => {
    const resolve = resolvePendingRef.current;
    resolvePendingRef.current = null;
    setPending(null);
    resolve?.(approved);
  }, []);

  // Hold raw mode so keystrokes never echo. While an approval is pending, y/n
  // answers it (Esc = no + cancel the turn); otherwise Esc cancels the turn.
  useInput(
    (inputChar, key) => {
      if (resolvePendingRef.current) {
        // Ignore buffered type-ahead for a beat so a keystroke meant for the
        // previous input can't blind-answer a prompt the user hasn't seen yet,
        // and ignore modified keys (Ctrl/Alt+Y arrive as a bare 'y').
        if (Date.now() - pendingSinceRef.current < 350) return;
        if (key.ctrl || key.meta) return;
        const ch = inputChar.toLowerCase();
        if (ch === 'y') resolvePending(true);
        else if (ch === 'n') resolvePending(false);
        else if (key.escape) {
          resolvePending(false);
          abortRef.current?.abort();
        }
        return;
      }
      if (key.escape) abortRef.current?.abort();
    },
    { isActive: isRawModeSupported },
  );

  // Re-render on terminal resize so the full-height layout tracks the window.
  const [, bumpResize] = useState(0);
  useEffect(() => {
    const onResize = (): void => bumpResize((n) => n + 1);
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  const rows = process.stdout.rows ?? 24;

  // --- display updates driven by the agent loop -----------------------------
  const appendText = useCallback((delta: string): void => {
    const cleanDelta = sanitizeText(delta);
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        const next = [...prev];
        next[next.length - 1] = { ...last, content: last.content + cleanDelta };
        return next;
      }
      return [...prev, { role: 'assistant', content: cleanDelta, streaming: true }];
    });
  }, []);

  const finalizeAssistant = useCallback((): void => {
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        if (last.content === '') return prev.slice(0, -1); // drop an empty reply
        const next = [...prev];
        next[next.length - 1] = { ...last, streaming: false };
        return next;
      }
      return prev;
    });
  }, []);

  // Returns a promise the agent loop awaits; it resolves when the user answers
  // the approval prompt (see useInput above).
  const confirm = useCallback(
    (req: {
      tool: string;
      args: Record<string, unknown>;
    }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        pendingSinceRef.current = Date.now();
        setPending({ tool: req.tool, args: req.args });
        resolvePendingRef.current = resolve;
      }),
    [],
  );

  const onSubmit = useCallback(
    async (raw: string): Promise<void> => {
      if (busyRef.current) return;
      const text = sanitizeText(raw.trim());
      setInput('');
      if (text === '') return;
      if (text === '/exit' || text === '/quit') {
        exit();
        return;
      }

      busyRef.current = true;
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;

      setTurns((prev) => [...prev, { role: 'user', content: text }]);
      history.current.push({ role: 'user', content: text });

      const events: AgentEvents = {
        onText: appendText,
        onToolCall: (name, args) => {
          finalizeAssistant();
          setTurns((prev) => [
            ...prev,
            { role: 'tool-call', content: sanitizeText(`${name}(${compactArgs(args)})`) },
          ]);
        },
        onToolResult: (_name, result, isError) => {
          const safeResult = isError ? result : summarize(result);
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
        await runAgent(provider, history.current, events, controller.signal);
        finalizeAssistant();
        if (controller.signal.aborted) {
          dropIncompleteTail(history.current);
          setTurns((prev) => [...prev, { role: 'system', content: sanitizeText('[cancelled]') }]);
        }
      } catch (err) {
        finalizeAssistant();
        dropIncompleteTail(history.current); // stay valid, keep completed writes
        const msg = err instanceof Error ? err.message : String(err);
        setTurns((prev) => [...prev, { role: 'system', content: sanitizeText(`⚠ ${msg}`) }]);
      } finally {
        if (resolvePendingRef.current) resolvePending(false);
        abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    },
    [provider, exit, appendText, finalizeAssistant, confirm, resolvePending],
  );

  return (
    <Box flexDirection="column" height={rows}>
      <Box
        flexDirection="column"
        flexGrow={1}
        justifyContent="flex-end"
      >
        {turns.map((turn, index) => (
          <TurnView key={index} turn={turn} />
        ))}
      </Box>

      <Box
        flexShrink={0}
        marginTop={1}
        borderStyle="round"
        borderColor={pending ? 'yellow' : busy ? 'gray' : 'cyan'}
        paddingX={1}
      >
        {pending ? (
          <ApprovalPrompt pending={pending} />
        ) : busy ? (
          <Box flexDirection="column">
            <Text color="cyanBright">
              <Spinner type="dots" /> thinking… <Text color="white">|</Text>{' '}
              <Text color="gray">(Esc to cancel)</Text>
            </Text>
            <StatusBar />
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box>
              <Text color="cyan">❯ </Text>
              <TextInput
                value={input}
                onChange={(v) => setInput(v.replace(/[\r\n]+/g, ' '))}
                onSubmit={onSubmit}
                placeholder="type a message · /exit to quit"
              />
            </Box>
            <StatusBar />
          </Box>
        )}
      </Box>
    </Box>
  );
}

function StatusBar(): React.ReactElement {
  return (
    <Box flexShrink={0} paddingY={0}>
      <Text color="gray" dimColor>
        {process.cwd()} · context: 200k
      </Text>
    </Box>
  );
}

function ApprovalPrompt({
  pending,
}: {
  pending: PendingApproval;
}): React.ReactElement {
  const rawPath = typeof pending.args.path === 'string' ? pending.args.path : '?';
  const path = sanitize(normalize(rawPath)); // the resolved, un-spoofable path
  const content =
    typeof pending.args.content === 'string' ? pending.args.content : '';
  const lines = content.split('\n');
  const preview = lines
    .slice(0, 8)
    .map((line) => sanitize(line.slice(0, 500)).slice(0, 200));
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
            <Text color="gray">│ … (+{lines.length - preview.length} more)</Text>
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
        <Text color="gray"> = no · Esc = cancel turn</Text>
      </Text>
    </Box>
  );
}

function TurnView({ turn }: { turn: Turn }): React.ReactElement {
  switch (turn.role) {
    case 'header':
      return (
        <Box marginBottom={1}>
          <Text color="magenta" bold>
            {sanitizeText(turn.content)}
          </Text>
        </Box>
      );
    case 'system':
      return (
        <Box marginBottom={1}>
          <Text color="yellow">{sanitizeText(turn.content)}</Text>
        </Box>
      );
    case 'tool-call':
      return (
        <Box marginBottom={1}>
          <Text color="blueBright">🔧 {sanitizeText(turn.content)}</Text>
        </Box>
      );
    case 'tool-result':
      return (
        <Box marginBottom={1}>
          <Text color={turn.error ? 'red' : 'gray'}>✓ {sanitizeText(turn.content)}</Text>
        </Box>
      );
    default: {
      const isUser = turn.role === 'user';
      const body =
        turn.content !== '' ? sanitizeText(turn.content) : turn.streaming ? '…' : '';
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={isUser ? 'cyan' : 'green'} bold>
            {isUser ? 'you' : '🐙 polvo'}
          </Text>
          <Text>{body}</Text>
        </Box>
      );
    }
  }
}
