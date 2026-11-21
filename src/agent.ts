import type { Message, Provider } from './provider.js';
import { TOOLS, TOOL_SCHEMAS } from './tools.js';

export interface AgentEvents {
  onText(delta: string): void;
  onToolCall(name: string, args: Record<string, unknown>): void;
  onToolResult(name: string, result: string, isError: boolean): void;
  /** Ask the user to approve a tool that mutates state; resolves true to allow. */
  confirm(request: {
    tool: string;
    args: Record<string, unknown>;
  }): Promise<boolean>;
}

const MAX_STEPS = 25;

/**
 * Run one user turn to completion: call the model, run any tools it asks for,
 * feed the results back, and loop until it replies with no tool calls. Tools
 * marked requiresApproval are gated behind events.confirm first. Mutates
 * `history` in place (appends the assistant turn and one 'tool' turn per call),
 * so the caller can roll back to a saved length on failure.
 */
export async function runAgent(
  provider: Provider,
  history: Message[],
  events: AgentEvents,
  signal?: AbortSignal,
): Promise<void> {
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return;

    const { text, toolCalls } = await provider.chat(
      history,
      TOOL_SCHEMAS,
      events.onText,
      signal,
    );

    history.push({
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });

    if (toolCalls.length === 0 || signal?.aborted) return;

    for (const call of toolCalls) {
      events.onToolCall(call.name, call.args);
      const tool = Object.hasOwn(TOOLS, call.name) ? TOOLS[call.name] : undefined;
      let result: string;
      let isError = false;
      if (!tool) {
        result = `unknown tool: ${call.name}`;
        isError = true;
      } else if (
        tool.requiresApproval &&
        !(await events.confirm({ tool: call.name, args: call.args }))
      ) {
        // A decline is a normal outcome, not an error — the model should adapt.
        result = 'the user declined this action';
      } else {
        try {
          result = await tool.run(call.args);
        } catch (err) {
          result = err instanceof Error ? err.message : String(err);
          isError = true;
        }
      }
      events.onToolResult(call.name, result, isError);
      history.push({ role: 'tool', content: result, tool_name: call.name });
      if (signal?.aborted) return; // Esc during a tool / its approval
    }
  }

  events.onText('\n[stopped: reached the tool-step limit]');
}
