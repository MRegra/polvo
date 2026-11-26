import type { ChatUsage, Message, Provider } from './provider.js';
import { TOOLS, TOOL_SCHEMAS, type Tool } from './tools.js';
import { capOutput, estimateTokens, fitContext } from './context.js';
import { failureReport, runChecks, type CheckResult } from './checks.js';

export interface AgentEvents {
  onText(delta: string): void;
  onToolCall(name: string, args: Record<string, unknown>): void;
  onToolResult(name: string, result: string, isError: boolean): void;
  /** Ask the user to approve an action; resolves true to allow. */
  confirm(request: {
    tool: string;
    args: Record<string, unknown>;
  }): Promise<boolean>;
  /** A project check finished (after the model changed files). */
  onCheck?(result: CheckResult): void;
  /** Token/timing metrics from a completed model call. */
  onUsage?(usage: ChatUsage): void;
  /** Harness notices: context trimmed, loop stopped, checks gave up … */
  onNotice?(text: string): void;
}

export interface AgentOptions {
  /** Max model calls in this turn. */
  maxSteps: number;
  /** The model's context window in tokens; history is trimmed to fit. */
  contextTokens: number;
  /** Project checks to run once the model stops after changing files. */
  checks?: string[];
  /** Times failing checks are fed back before giving up. */
  maxFixAttempts?: number;
  /** Plan mode: only tools that need no approval (reads, read-only commands). */
  readOnly?: boolean;
}

/** Room kept for the system prompt, tool schemas and the model's reply. */
const OUTPUT_RESERVE = 4_096;
const SYSTEM_RESERVE = 1_500;
const SCHEMA_TOKENS = estimateTokens(JSON.stringify(TOOL_SCHEMAS));

/** Identical calls allowed before the harness refuses, and before it stops the turn. */
const REPEAT_REFUSE = 3;
const REPEAT_STOP = 5;

/** Checks the user approved this session (keyed by the exact command list). */
const approvedChecks = new Set<string>();
export function resetCheckApprovals(): void {
  approvedChecks.clear();
}

function needsApproval(tool: Tool, args: Record<string, unknown>): boolean {
  const r = tool.requiresApproval;
  return typeof r === 'function' ? r(args) : r === true;
}

function mutates(tool: Tool, args: Record<string, unknown>): boolean {
  const m = tool.mutates;
  return typeof m === 'function' ? m(args) : m === true;
}

/**
 * Run one user turn to completion: call the model, run the tools it asks for,
 * feed the results back, and loop until it replies with no tool calls. The
 * harness, not the model, enforces the guarantees:
 *   - approval for anything that changes state,
 *   - every tool output capped, and the history trimmed to the context window,
 *   - a step limit and a stop on repeated identical calls,
 *   - after file changes, the project's checks must pass before the turn ends
 *     (failures go back to the model, up to maxFixAttempts times).
 * Mutates `history` in place, so the caller can roll back on failure.
 */
export async function runAgent(
  provider: Provider,
  history: Message[],
  events: AgentEvents,
  signal: AbortSignal | undefined,
  options: AgentOptions,
): Promise<void> {
  const { maxSteps, contextTokens, checks = [], maxFixAttempts = 3, readOnly = false } = options;
  const budget = Math.max(2_000, contextTokens - OUTPUT_RESERVE - SYSTEM_RESERVE - SCHEMA_TOKENS);
  const schemas = readOnly
    ? TOOL_SCHEMAS.filter((s) => TOOLS[s.name]?.requiresApproval !== true)
    : TOOL_SCHEMAS;
  const seen = new Map<string, number>();
  let changedFiles = false;
  let fixAttempts = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return;

    const trimmed = fitContext(history, budget);
    if (trimmed.elided || trimmed.dropped) {
      events.onNotice?.(
        `context trimmed to fit ${contextTokens} tokens` +
          (trimmed.elided ? ` · ${trimmed.elided} old tool output(s) removed` : '') +
          (trimmed.dropped ? ` · ${trimmed.dropped} old message(s) dropped` : ''),
      );
    }

    const { text, toolCalls, usage } = await provider.chat(history, schemas, events.onText, signal);
    if (usage) events.onUsage?.(usage);

    history.push({
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });
    if (signal?.aborted) return;

    if (toolCalls.length === 0) {
      if (!changedFiles || checks.length === 0) return;
      const key = JSON.stringify(checks);
      if (!approvedChecks.has(key)) {
        if (!(await events.confirm({ tool: 'run_checks', args: { commands: checks } }))) {
          events.onNotice?.('checks skipped — not approved');
          return;
        }
        approvedChecks.add(key);
      }
      if (signal?.aborted) return;
      const results = await runChecks(checks);
      results.forEach((r) => events.onCheck?.(r));
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) return;
      if (fixAttempts >= maxFixAttempts) {
        events.onNotice?.(`checks still failing after ${maxFixAttempts} fix attempt(s) — stopping; over to you`);
        return;
      }
      fixAttempts++;
      changedFiles = false;
      history.push({ role: 'user', content: failureReport(failed), synthetic: true });
      continue;
    }

    let stop = false;
    for (const call of toolCalls) {
      events.onToolCall(call.name, call.args);
      const tool = Object.hasOwn(TOOLS, call.name) ? TOOLS[call.name] : undefined;
      const signature = `${call.name}:${JSON.stringify(call.args)}`;
      const count = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, count);

      let result: string;
      let isError = false;
      if (!tool) {
        result = `unknown tool: ${call.name}. Available: ${schemas.map((s) => s.name).join(', ')}`;
        isError = true;
      } else if (count >= REPEAT_REFUSE) {
        result = `you already made this exact ${call.name} call ${count - 1} times; the result will not change. Try a different approach, or answer the user with what you have.`;
        isError = true;
        if (count >= REPEAT_STOP) stop = true;
      } else if (readOnly && needsApproval(tool, call.args)) {
        result = 'plan mode is read-only: this action is not allowed. Finish the plan; the user will ask you to carry it out.';
        isError = true;
      } else if (
        needsApproval(tool, call.args) &&
        !(await events.confirm({ tool: call.name, args: call.args }))
      ) {
        // A decline is a normal outcome, not an error — the model should adapt.
        result = 'the user declined this action';
      } else {
        try {
          result = await tool.run(call.args);
          if (mutates(tool, call.args)) {
            changedFiles = true;
            // After a file changes, re-reading it can legitimately return new content.
            for (const key of seen.keys()) {
              if (key.startsWith('read_file:') || key.startsWith('grep:')) seen.delete(key);
            }
          }
        } catch (err) {
          result = err instanceof Error ? err.message : String(err);
          isError = true;
        }
      }
      result = capOutput(result);
      events.onToolResult(call.name, result, isError);
      history.push({ role: 'tool', content: result, tool_name: call.name });
      if (signal?.aborted) return; // Esc during a tool / its approval
    }
    if (stop) {
      events.onNotice?.('stopped: the model kept repeating the same tool call');
      return;
    }
  }

  events.onNotice?.(`stopped: reached the limit of ${maxSteps} steps for one turn`);
}
