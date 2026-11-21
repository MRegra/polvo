import { Ollama } from 'ollama';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A model backend. Everything the agent needs from an LLM goes through this
 * interface, so swapping the local model for a different one — or a remote API
 * later — is a new class, not a rewrite of the REPL.
 */
export interface Provider {
  readonly name: string;
  readonly model: string;
  /**
   * Stream one assistant reply. Calls `onText` with each text delta as it
   * arrives, and resolves to the complete reply text.
   */
  stream(messages: Message[], onText: (delta: string) => void): Promise<string>;
}

const DEFAULT_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

export class OllamaProvider implements Provider {
  readonly name = 'ollama';
  private readonly client: Ollama;

  constructor(
    readonly model: string,
    private readonly system: string,
    host: string = DEFAULT_HOST,
  ) {
    this.client = new Ollama({ host });
  }

  async stream(
    messages: Message[],
    onText: (delta: string) => void,
  ): Promise<string> {
    const response = await this.client.chat({
      model: this.model,
      stream: true,
      messages: [{ role: 'system', content: this.system }, ...messages],
    });

    let full = '';
    for await (const part of response) {
      const delta = part.message?.content ?? '';
      if (delta) {
        full += delta;
        onText(delta);
      }
    }
    return full;
  }
}

/**
 * Preflight: is Ollama reachable, and is the model present? Returns a
 * human-readable warning, or null when all is well. Never throws — a startup
 * hint must not block the program.
 */
export async function checkOllama(
  model: string,
  host: string = DEFAULT_HOST,
): Promise<string | null> {
  try {
    const baseUrl = (
      /^https?:\/\//.test(host) ? host : `http://${host}`
    ).replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return `Ollama at ${host} responded ${res.status}`;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const names = (data.models ?? []).map((m) => m.name);
    const base = (s: string): string => s.split(':')[0] ?? s;
    if (!names.some((n) => n === model || base(n) === base(model))) {
      return `model "${model}" is not pulled — run:  ollama pull ${model}`;
    }
    return null;
  } catch {
    return `can't reach Ollama at ${host} — is it running?  (try: ollama serve)`;
  }
}
