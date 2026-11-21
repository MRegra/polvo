import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { Message, Provider } from './provider.js';

type Role = 'header' | 'system' | 'user' | 'assistant';

interface Turn {
  role: Role;
  content: string;
}

interface Props {
  provider: Provider;
  warning?: string | null;
}

/**
 * The whole polvo UI. The app fills the full terminal height: the conversation
 * is bottom-aligned in a flexible area (newest turns sit just above the input;
 * older ones scroll off the top), and the input box is pinned to the bottom.
 * No tools yet — on submit we just stream the model's reply.
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
      { role: 'header', content: `🐙 polvo v0.1.1 · model: ${provider.model}` },
    ];
    if (warning) seed.push({ role: 'system', content: warning });
    return seed;
  });
  const [streaming, setStreaming] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const busy = streaming !== null;

  // The real conversation sent to the model (user/assistant only — never the
  // header or system notices shown above).
  const history = useRef<Message[]>([]);

  const onSubmit = useCallback(
    async (raw: string): Promise<void> => {
      const text = raw.trim();
      setInput('');
      if (text === '') return;
      if (text === '/exit' || text === '/quit') {
        exit();
        return;
      }

      setTurns((prev) => [...prev, { role: 'user', content: text }]);
      history.current.push({ role: 'user', content: text });
      setStreaming('');

      try {
        const reply = await provider.stream(history.current, (delta) => {
          setStreaming((s) => (s ?? '') + delta);
        });
        if (reply.trim() === '') {
          history.current.pop(); // drop the unanswered user turn
          setTurns((prev) => [
            ...prev,
            { role: 'system', content: '(empty reply)' },
          ]);
        } else {
          history.current.push({ role: 'assistant', content: reply });
          setTurns((prev) => [...prev, { role: 'assistant', content: reply }]);
        }
      } catch (err) {
        history.current.pop();
        const msg = err instanceof Error ? err.message : String(err);
        setTurns((prev) => [...prev, { role: 'system', content: `⚠ ${msg}` }]);
      } finally {
        setStreaming(null);
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
        {streaming !== null && (
          <TurnView turn={{ role: 'assistant', content: streaming || '…' }} />
        )}
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
              onChange={setInput}
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
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={isUser ? 'cyan' : 'green'} bold>
        {isUser ? 'you' : '🐙 polvo'}
      </Text>
      <Text>{turn.content}</Text>
    </Box>
  );
}
