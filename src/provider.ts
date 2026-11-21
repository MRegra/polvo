import { Ollama, type Message as OllamaMessage, type Tool } from 'ollama';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[]; // on assistant turns that call tools
  tool_name?: string; // on tool-result turns
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema for the tool's args
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
}

/**
 * A model backend. One call = one model response, which is either text, a set
 * of tool calls, or both. The agent loop (src/agent.ts) drives the tools; the
 * provider only knows how to talk to the model.
 */
export interface Provider {
  readonly name: string;
  readonly model: string;
  chat(
    messages: Message[],
    tools: ToolSchema[],
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
}

const DEFAULT_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

function toOllama(m: Message): OllamaMessage {
  const msg: OllamaMessage = { role: m.role, content: m.content };
  if (m.tool_calls?.length) {
    msg.tool_calls = m.tool_calls.map((tc) => ({
      function: { name: tc.name, arguments: tc.args },
    }));
  }
  if (m.tool_name) msg.tool_name = m.tool_name;
  return msg;
}

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

  async chat(
    messages: Message[],
    tools: ToolSchema[],
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const ollamaTools: Tool[] = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Tool['function']['parameters'],
      },
    }));

    const response = await this.client.chat({
      model: this.model,
      stream: true,
      messages: [
        { role: 'system', content: this.system },
        ...messages.map(toOllama),
      ],
      tools: ollamaTools,
      options: { num_ctx: 8192 },
    });

    // Esc / Ctrl-C aborts the in-flight generation (see src/app.tsx).
    if (signal) {
      signal.addEventListener('abort', () => response.abort(), { once: true });
    }

    let text = '';
    const toolCalls: ToolCall[] = [];
    try {
      for await (const part of response) {
        const delta = part.message?.content ?? '';
        if (delta) {
          text += delta;
          onText(delta);
        }
        for (const call of part.message?.tool_calls ?? []) {
          toolCalls.push({
            name: call.function.name,
            args: (call.function.arguments ?? {}) as Record<string, unknown>,
          });
        }
      }
    } catch (err) {
      if (signal?.aborted) return { text, toolCalls }; // abort is not an error
      throw err;
    }
    return { text, toolCalls };
  }
}

/**
 * Preflight: is Ollama reachable, and is the model present? Returns a
 * human-readable warning, or null when all is well. Never throws.
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
