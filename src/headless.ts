import { runAgent, type AgentEvents } from './agent.js';
import type { Config } from './config.js';
import { estimateMessages } from './context.js';
import type { Message, Provider } from './provider.js';

/**
 * `polvo run "<task>"`: one agent turn with no TUI — for scripts, timers and
 * the eval suite. Without --yes every approval is declined, so it can only
 * read. --yes approves file edits/writes inside the project and the
 * project's checks, but still declines run_command calls that would need
 * approval: an unattended run never executes an arbitrary command.
 */

export interface HeadlessOptions {
  yes: boolean;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface HeadlessResult {
  status: 'ok' | 'error';
  error?: string;
  text: string;
  /** Model calls made. */
  steps: number;
  toolCalls: Array<{ name: string; error: boolean }>;
  checks: Array<{ command: string; ok: boolean }>;
  declined: string[];
  notices: string[];
  /** Estimated tokens in the final history. */
  contextTokens: number;
  durationMs: number;
}

const AUTO_APPROVE_WITH_YES = new Set(['edit_file', 'write_file', 'run_checks']);

export async function runHeadless(
  provider: Provider,
  config: Pick<Config, 'maxSteps' | 'checks' | 'maxFixAttempts'>,
  prompt: string,
  options: HeadlessOptions,
): Promise<HeadlessResult> {
  const started = Date.now();
  const result: HeadlessResult = {
    status: 'ok', text: '', steps: 0, toolCalls: [], checks: [], declined: [], notices: [],
    contextTokens: 0, durationMs: 0,
  };
  // Count model calls without touching the agent loop.
  const counted: Provider = {
    name: provider.name,
    model: provider.model,
    contextTokens: provider.contextTokens,
    chat: (...args) => {
      result.steps++;
      return provider.chat(...args);
    },
  };
  let finalText = '';
  const events: AgentEvents = {
    onText: (d) => {
      finalText += d;
      options.onText?.(d);
    },
    onToolCall: () => {
      finalText = ''; // keep only the text after the last tool call: the answer
    },
    onToolResult: (name, _r, isError) => result.toolCalls.push({ name, error: isError }),
    confirm: async ({ tool }) => {
      const ok = options.yes && AUTO_APPROVE_WITH_YES.has(tool);
      if (!ok) result.declined.push(tool);
      return ok;
    },
    onCheck: (r) => result.checks.push({ command: r.command, ok: r.ok }),
    onNotice: (t) => result.notices.push(t),
  };
  const history: Message[] = [{ role: 'user', content: prompt }];
  try {
    await runAgent(counted, history, events, options.signal, {
      maxSteps: config.maxSteps,
      contextTokens: provider.contextTokens,
      checks: config.checks,
      maxFixAttempts: config.maxFixAttempts,
    });
  } catch (err) {
    result.status = 'error';
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.text = finalText.trim();
  result.contextTokens = estimateMessages(history);
  result.durationMs = Date.now() - started;
  return result;
}
