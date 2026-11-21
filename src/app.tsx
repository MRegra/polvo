import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { AgentEvents } from './agent.js';
import { runAgent } from './agent.js';
import type { Message, Provider } from './provider.js';

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
      { role: 'header', content: `🐙 polvo v0.2.1 · model: ${provider.model}` },
    ];
    if (warning) seed.push({ role: 'system', content: warning });
    return seed;
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const busyRef = useRef(false); // authoritative re-entrancy guard
  const abortRef = useRef<AbortController | null>(null);
  const history = useRef<Message[]>([]); // user/assistant/tool messages for the model

  // Hold raw mode so keystrokes never echo; Esc cancels an in-flight turn.
  useInput(
    (_input, key) => {
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
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        const next = [...prev];
        next[next.length - 1] = { ...last, content: last.content + delta };
        return next;
      }
      return [...prev, { role: 'assistant', content: delta, streaming: true }];
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

  const onSubmit = useCallback(
    async (raw: string): Promise<void> => {
      if (busyRef.current) return;
      const text = raw.trim();
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
      const mark = history.current.length; // roll back to here on cancel/failure
      history.current.push({ role: 'user', content: text });

      const events: AgentEvents = {
        onText: appendText,
        onToolCall: (name, args) => {
          finalizeAssistant();
          setTurns((prev) => [
            ...prev,
            { role: 'tool-call', content: `${name}(${compactArgs(args)})` },
          ]);
        },
        onToolResult: (_name, result, isError) => {
          setTurns((prev) => [
            ...prev,
            {
              role: 'tool-result',
              content: isError ? result : summarize(result),
              error: isError,
            },
          ]);
        },
      };

      try {
        await runAgent(provider, history.current, events, controller.signal);
        finalizeAssistant();
        if (controller.signal.aborted) {
          history.current = history.current.slice(0, mark);
          setTurns((prev) => [...prev, { role: 'system', content: '[cancelled]' }]);
        }
      } catch (err) {
        finalizeAssistant();
        history.current = history.current.slice(0, mark); // keep history valid
        const msg = err instanceof Error ? err.message : String(err);
        setTurns((prev) => [...prev, { role: 'system', content: `⚠ ${msg}` }]);
      } finally {
        abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    },
    [provider, exit, appendText, finalizeAssistant],
  );

  return (
    <Box flexDirection="column" height={rows}>
      <Box
        flexDirection="column"
        flexGrow={1}
        justifyContent="flex-end"
        overflow="hidden"
      >
        {turns.map((turn, index) => (
          <TurnView key={index} turn={turn} />
        ))}
      </Box>

      <Box
        flexShrink={0}
        marginTop={1}
        borderStyle="round"
        borderColor={busy ? 'gray' : 'cyan'}
        paddingX={1}
      >
        {busy ? (
          <Text color="cyanBright">
            <Spinner type="dots" /> thinking…{' '}
            <Text color="gray">(Esc to cancel)</Text>
          </Text>
        ) : (
          <Box>
            <Text color="cyan">❯ </Text>
            <TextInput
              value={input}
              onChange={(v) => setInput(v.replace(/[\r\n]+/g, ' '))}
              onSubmit={onSubmit}
              placeholder="type a message · /exit to quit"
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

function TurnView({ turn }: { turn: Turn }): React.ReactElement {
  switch (turn.role) {
    case 'header':
      return (
        <Box marginBottom={1}>
          <Text color="magenta" bold>
            {turn.content}
          </Text>
        </Box>
      );
    case 'system':
      return (
        <Box marginBottom={1}>
          <Text color="yellow">{turn.content}</Text>
        </Box>
      );
    case 'tool-call':
      return (
        <Box>
          <Text color="blueBright">🔧 {turn.content}</Text>
        </Box>
      );
    case 'tool-result':
      return (
        <Box marginBottom={1}>
          <Text color={turn.error ? 'red' : 'gray'}> {turn.content}</Text>
        </Box>
      );
    default: {
      const isUser = turn.role === 'user';
      const body =
        turn.content !== '' ? turn.content : turn.streaming ? '…' : '';
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
