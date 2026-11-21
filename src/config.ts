export interface Config {
  model: string;
  system: string;
}

const SYSTEM_PROMPT = `You are polvo, a coding assistant that runs in a terminal.
Be concise and direct — this is a terminal, so keep Markdown light.
You cannot read or write files or run commands yet; that capability
arrives in a later version. When you lack a capability, say so plainly
instead of pretending to have it.`;

/** Resolve runtime config. Precedence: CLI flag > env > built-in default. */
export function loadConfig(cliModel?: string): Config {
  const model = cliModel ?? process.env.POLVO_MODEL ?? 'qwen3-coder:30b';
  return { model, system: SYSTEM_PROMPT };
}
