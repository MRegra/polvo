import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { Message, Provider } from './provider.js';

type Role = 'header' | 'system' | 'user' | 'assistant';

interface Turn {
  role: Role;
  content: string;
  streaming?: boolean; // an assistant turn still being written
}

interface Props {
  provider: Provider;
  warning?: string | null;
}

/**
 * The whole polvo UI. The app fills the full terminal height: the conversation
 * is bottom-aligned in a flexible area (newest turns sit just above the input;
 * older ones scroll off the top), and the input box is pinned to the bottom.
 *
 * All displayed turns live in one `turns` list — the in-progress reply is just
 * the last turn with `streaming: true`, mutated in place — so a reply never
 * renders twice. `history` is the parallel message list sent to the model.
 * No tools yet: on submit we stream one reply.
 */
export function App({ provider, warning }: Props): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();

  // Hold raw mode for the whole session so every keystroke is captured by Ink
  // and never echoed by the terminal — including while a reply is generating.
  useInput(() => {}, { isActive: isRawModeSupported });

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

  const [turns, setTurns] = useState<Turn[]>(() => {
    const seed: Turn[] = [
      { role: 'header', content: `🐙 polvo v0.1.2 · model: ${provider.model}` },
    ];
    if (warning) seed.push({ role: 'system', content: warning });
    return seed;
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // Authoritative re-entrancy guard: a stale key event (or a future tool-loop
  // step) must not start a second turn while one is running. State alone isn't
  // enough on Ink 5's legacy React root.
  const busyRef = useRef(false);

  // The real conversation sent to the model (user/assistant only).
  const history = useRef<Message[]>([]);

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
      setTurns((prev) => [
        ...prev,
        { role: 'user', content: text },
        { role: 'assistant', content: '', streaming: true },
      ]);
      history.current = [...history.current, { role: 'user', content: text }];

      try {
        const reply = await provider.stream([...history.current], (delta) => {
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1]!;
            next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          });
        });

        if (reply.trim() === '') {
          history.current = history.current.slice(0, -1); // drop unanswered user turn
          setTurns((prev) => [
            ...prev.slice(0, -1), // remove the empty streaming turn
            { role: 'system', content: '(empty reply)' },
          ]);
        } else {
          history.current = [
            ...history.current,
            { role: 'assistant', content: reply },
          ];
          setTurns((prev) => [
            ...prev.slice(0, -1),
            { role: 'assistant', content: reply },
          ]);
        }
      } catch (err) {
        history.current = history.current.slice(0, -1);
        const msg = err instanceof Error ? err.message : String(err);
        setTurns((prev) => [
          ...prev.slice(0, -1),
          { role: 'system', content: `⚠ ${msg}` },
        ]);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [provider, exit],
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
            <Spinner type="dots" /> thinking…
          </Text>
        ) : (
          <Box>
            <Text color="cyan">❯ </Text>
            <TextInput
              value={input}
              // Flatten pasted newlines/CR so a multi-line paste can't corrupt
              // the single-line box (proper multi-line input comes later).
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
  if (turn.role === 'header') {
    return (
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          {turn.content}
        </Text>
      </Box>
    );
  }
  if (turn.role === 'system') {
    return (
      <Box marginBottom={1}>
        <Text color="yellow">{turn.content}</Text>
      </Box>
    );
  }
  const isUser = turn.role === 'user';
  const body = turn.content !== '' ? turn.content : turn.streaming ? '…' : '';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={isUser ? 'cyan' : 'green'} bold>
        {isUser ? 'you' : '🐙 polvo'}
      </Text>
      <Text>{body}</Text>
    </Box>
  );
}
