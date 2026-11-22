import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { AgentEvents } from './agent.js';
import { runAgent } from './agent.js';
import type { Message, Provider } from './provider.js';
import { normalize } from 'node:path';
import { SYSTEM_PROMPT } from './config.js';

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

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  return Math.floor(trimmed.length / 4);
}

const CONTEXT_WINDOW_TOKENS = 200_000;

function renderMarkdown(content: string): React.ReactElement {
  const parts: React.ReactElement[] = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={parts.length}>
          {processInlineMarkdown(content.slice(lastIndex, match.index))}
        </Text>
      );
    }

    const code = match[2].trim();

    parts.push(
      <Box key={parts.length} marginY={1}>
        <Text color="gray">{code}</Text>
      </Box>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(
      <Text key={parts.length}>
        {processInlineMarkdown(content.slice(lastIndex))}
      </Text>
    );
  }

  return <>{parts}</>;
}

function processInlineMarkdown(text: string): React.ReactElement {
  const elements: React.ReactElement[] = [];
  let lastIndex = 0;

  const boldRegex = /(\*\*|__)([^*_]+)\1/g;
  let match;

  while ((match = boldRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(
        <Text key={elements.length}>
          {text.slice(lastIndex, match.index)}
        </Text>
      );
    }

    elements.push(
      <Text key={elements.length} bold>
        {match[2]}
      </Text>
    );

    lastIndex = match.index + match[0].length;
  }

  const italicRegex = /([^*_])(\*|_)([^*_]+)\2/g;

  while ((match = italicRegex.exec(text)) !== null) {
    if (match[1] !== ' ' && match[1] !== '') continue;

    if (match.index > lastIndex) {
      elements.push(
        <Text key={elements.length}>
          {text.slice(lastIndex, match.index)}
        </Text>
      );
    }

    elements.push(
      <Text key={elements.length} italic>
        {match[3]}
      </Text>
    );

    lastIndex = match.index + match[0].length;
  }

  const inlineCodeRegex = /`([^`]+)`/g;

  while ((match = inlineCodeRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(
        <Text key={elements.length}>
          {text.slice(lastIndex, match.index)}
        </Text>
      );
    }

    elements.push(
      <Text key={elements.length} color="gray">
        {match[1]}
      </Text>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push(
      <Text key={elements.length}>
        {text.slice(lastIndex)}
      </Text>
    );
  }

  return <>{elements}</>;
}

function estimateHistoryTokens(history: Message[]): number {
  let total = 0;

  for (const msg of history) {
    total += estimateTokens(msg.content);
  }

  return total;
}

function compactHistory(
  history: Message[],
  maxTokens: number = CONTEXT_WINDOW_TOKENS
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
    } else {
      if (msg.role === 'user' && result.length > 0 && result[0].role !== 'user') {
        // Old messages are dropped when the context limit is exceeded.
      }
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

function estimateTurnRows(turn: Turn, columns: number): number {
  const width = Math.max(20, columns - 4);
  const content = sanitizeText(turn.content);

  const lines = content.split('\n').reduce(
    (sum, line) =>
      sum + Math.max(1, Math.ceil(Math.max(1, line.length) / width)),
    0
  );

  return Math.max(
    2,
    lines + (turn.role === 'assistant' || turn.role === 'user' ? 2 : 1)
  );
}

/**
 * Main Polvo application.
 *
 * Conversation history is displayed inside a height-constrained viewport.
 * The viewport supports keyboard navigation through previous turns.
 */
export function App({ provider, warning }: Props): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();

  const [turns, setTurns] = useState<Turn[]>(() => {
    const seed: Turn[] = [
      {
        role: 'header',
        content: sanitizeText(`🐙 polvo v0.3.15 · model: ${provider.model}`),
      },
    ];

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
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [tokenCount, setTokenCount] = useState(0);

  // Scroll position measured in approximate terminal rows from the bottom.
  // Zero means follow the newest conversation output.
  const [scrollOffset, setScrollOffset] = useState(0);

  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const resolvePendingRef = useRef<((approved: boolean) => void) | null>(null);
  const pendingSinceRef = useRef(0);
  const history = useRef<Message[]>([]);

  const [contextTokenCount, setContextTokenCount] = useState(0);

  useEffect(() => {
    let count = estimateTokens(SYSTEM_PROMPT);

    for (const msg of history.current) {
      count += estimateTokens(msg.content);
    }

    setContextTokenCount(count);
  }, [turns, history.current.length]);

  const resolvePending = useCallback((approved: boolean): void => {
    const resolve = resolvePendingRef.current;

    resolvePendingRef.current = null;
    setPending(null);
    resolve?.(approved);
  }, []);

  // Keyboard navigation and approval handling.
  useInput(
    (inputChar, key) => {
      if (resolvePendingRef.current) {
        if (Date.now() - pendingSinceRef.current < 350) return;
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

      // Scrolling is available when the input is empty.
      if (input.length === 0) {
        const pageSize = Math.max(3, (process.stdout.rows ?? 24) - 6);

        if (key.pageUp || (key.ctrl && inputChar.toLowerCase() === 'u')) {
          setScrollOffset((current) => current + pageSize);
        } else if (
          key.pageDown ||
          (key.ctrl && inputChar.toLowerCase() === 'd')
        ) {
          setScrollOffset((current) => Math.max(0, current - pageSize));
        } else if (key.upArrow) {
          setScrollOffset(Number.MAX_SAFE_INTEGER);
        } else if (key.downArrow) {
          setScrollOffset(0);
        }
      }
    },
    { isActive: isRawModeSupported }
  );

  // Terminal resize handling.
  const [, bumpResize] = useState(0);

  useEffect(() => {
    const onResize = (): void => bumpResize((n) => n + 1);

    process.stdout.on('resize', onResize);

    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);

  const rows = process.stdout.rows ?? 24;
  const columns = process.stdout.columns ?? 80;

  const fixedRows = 5 + (pending || busy ? 1 : 0);
  const conversationRows = Math.max(1, rows - fixedRows);

  // Calculate approximate height of each conversation turn.
  const turnHeights = turns.map((turn) =>
    estimateTurnRows(turn, columns)
  );

  const totalConversationRows = turnHeights.reduce(
    (sum, height) => sum + height,
    0
  );

  const maxScrollOffset = Math.max(
    0,
    totalConversationRows - conversationRows
  );

  const effectiveScrollOffset = Math.min(
    scrollOffset,
    maxScrollOffset
  );

  // Determine the visible conversation turns from the bottom upwards.
  let endIndex = turns.length;
  let rowsFromBottom = 0;

  while (
    endIndex > 0 &&
    rowsFromBottom < effectiveScrollOffset
  ) {
    rowsFromBottom += turnHeights[endIndex - 1];
    endIndex--;
  }

  let startIndex = endIndex;
  let visibleRows = rowsFromBottom;

  while (
    startIndex > 0 &&
    visibleRows < conversationRows
  ) {
    startIndex--;
    visibleRows += turnHeights[startIndex];
  }

  const visibleTurns = turns.slice(startIndex, endIndex);
  const isBrowsingHistory = effectiveScrollOffset > 0;

  // Agent output handling.
  const appendText = useCallback((delta: string): void => {
    const cleanDelta = sanitizeText(delta);

    setTurns((prev) => {
      const last = prev[prev.length - 1];

      if (last?.role === 'assistant' && last.streaming) {
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
  }, []);

  const finalizeAssistant = useCallback((): void => {
    setTurns((prev) => {
      const last = prev[prev.length - 1];

      if (last?.role === 'assistant' && last.streaming) {
        if (last.content === '') return prev.slice(0, -1);

        const next = [...prev];

        next[next.length - 1] = {
          ...last,
          streaming: false,
        };

        return next;
      }

      return prev;
    });
  }, []);

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
    []
  );

  const onSubmit = useCallback(
    async (raw: string): Promise<void> => {
      if (busyRef.current) return;

      const text = sanitizeText(raw.trim());

      setInput('');

      if (text === '') return;

      // Return to the latest message when sending a new prompt.
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
        history.current = compactHistory(history.current) as Message[];
      }

      const events: AgentEvents = {
        onText: appendText,

        onToolCall: (name, args) => {
          finalizeAssistant();

          setTurns((prev) => [
            ...prev,
            {
              role: 'tool-call',
              content: sanitizeText(`${name}(${compactArgs(args)})`),
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
          controller.signal
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
          err instanceof Error ? err.message : String(err);

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
    ]
  );

  return (
    <Box flexDirection="column" height={rows}>
      {/* Conversation viewport */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        height={conversationRows}
        overflow="hidden"
      >
        {visibleTurns.map((turn, index) => (
          <TurnView
            key={startIndex + index}
            turn={turn}
          />
        ))}

        {isBrowsingHistory ? (
          <Text color="yellow" dimColor>
            ↑ Browsing history · PageUp/PageDown · ↓ to return
          </Text>
        ) : null}
      </Box>

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
        <Box flexShrink={0} paddingX={1}>
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
              setInput(v.replace(/[\r\n]+/g, ' '))
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
    Math.floor((tokenCount / maxTokens) * 100)
  );

  return (
    <Box flexShrink={0} paddingX={1} paddingY={0}>
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
      sanitize(line.slice(0, 500)).slice(0, 200)
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

        <Text color="gray"> = no · Esc = cancel turn</Text>
      </Text>
    </Box>
  );
}

function TurnView({
  turn,
}: {
  turn: Turn;
}): React.ReactElement {
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
          <Text color="yellow">
            {sanitizeText(turn.content)}
          </Text>
        </Box>
      );

    case 'tool-call':
      return (
        <Box marginBottom={1}>
          <Text color="blueBright">
            🔧 {sanitizeText(turn.content)}
          </Text>
        </Box>
      );

    case 'tool-result':
      return (
        <Box marginBottom={1}>
          <Text color={turn.error ? 'red' : 'gray'}>
            ✓{' '}
          </Text>

          <Box>
            {renderMarkdown(sanitizeText(turn.content))}
          </Box>
        </Box>
      );

    default: {
      const isUser = turn.role === 'user';

      const body =
        turn.content !== ''
          ? sanitizeText(turn.content)
          : turn.streaming
            ? '…'
            : '';

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text
            color={isUser ? 'cyan' : 'green'}
            bold
          >
            {isUser ? 'you' : '🐙 polvo'}
          </Text>

          {isUser ? (
            <Text>{body}</Text>
          ) : (
            <Box>{renderMarkdown(body)}</Box>
          )}
        </Box>
      );
    }
  }
}