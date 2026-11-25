import type { Message } from './provider.js';

/** Cap applied to every tool result before it enters the history. */
export const TOOL_OUTPUT_CAP = 16_000;

/**
 * Keep the head and tail of a long tool output — errors and summaries tend to
 * be at the end, context at the start — and say how much was cut.
 */
export function capOutput(text: string, max: number = TOOL_OUTPUT_CAP): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.3);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n…[${omitted} chars omitted]…\n${text.slice(-tail)}`;
}

/**
 * Rough token estimate. Code tokenizes denser than prose, so divide by 3, not
 * 4 — overestimating trims a little early, underestimating overflows.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function estimateMessages(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4; // per-message framing
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

const ELIDED = '[old tool output removed to save context — run the tool again if you need it]';

/**
 * Make `history` fit `budget` tokens, in place. Every edit to an earlier
 * message invalidates Ollama's prompt cache, so trimming happens rarely and in
 * one batch, down to 70% of the budget:
 *   1. replace old tool outputs with a short note, oldest first, keeping the
 *      most recent `keepRecentTools`;
 *   2. drop whole turns from the start, cutting only at a user message so a
 *      tool call never loses its result. The latest user turn is always kept.
 * Returns what it did, for the UI.
 */
export function fitContext(
  history: Message[],
  budget: number,
  keepRecentTools = 4,
): { elided: number; dropped: number } {
  let elided = 0;
  let dropped = 0;
  if (estimateMessages(history) <= budget) return { elided, dropped };
  // Once over, trim well below the budget so the next trim (which breaks
  // Ollama's prompt cache again) is many turns away, not on the next call.
  const target = Math.floor(budget * 0.7);

  const toolIdx = history
    .map((m, i) => (m.role === 'tool' ? i : -1))
    .filter((i) => i >= 0);
  const elidable = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecentTools));
  for (const i of elidable) {
    if (estimateMessages(history) <= target) return { elided, dropped };
    if (history[i].content !== ELIDED) {
      history[i] = { ...history[i], content: ELIDED };
      elided++;
    }
  }

  while (estimateMessages(history) > target) {
    // Anchor on the user's real request, not a harness-injected report.
    let lastUser = history.length - 1;
    while (lastUser >= 0 && (history[lastUser].role !== 'user' || history[lastUser].synthetic)) lastUser--;
    // Next user message after index 0 marks the end of the oldest turn.
    const cut = history.findIndex((m, i) => i > 0 && m.role === 'user');
    if (cut <= 0 || cut > lastUser) break; // only the current turn is left
    history.splice(0, cut);
    dropped += cut;
  }
  return { elided, dropped };
}
