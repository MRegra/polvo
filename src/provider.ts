import { Ollama, type Message as OllamaMessage, type Tool } from 'ollama';
import { Agent, fetch as undiciFetch } from 'undici';
import { logDiagnostic } from './diagnostics.js';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  chat(
    messages: Message[],
    tools: ToolSchema[],
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
  unload?(): Promise<void>;
}

const DEFAULT_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const NUM_CTX = 200_000;

/**
 * Node's built-in fetch gives up after 5 minutes without response headers.
 * Ollama sends no headers until the first token, and on CPU a long prompt can
 * take longer than that to process, so the request died with "fetch failed".
 * Disable those timeouts; Esc still cancels through the AbortSignal.
 */
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** "fetch failed" hides the real reason in err.cause — surface it. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return `${err.message}: ${cause.message}${code ? ` (${code})` : ''}`;
  }
  return err.message;
}

function normalizeHost(host: string): string {
  return ( /^https?:\/\//.test(host) ? host : `http://${host}` ).replace(/\/$/, '');
}

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
  private readonly host: string;
  private activeSignal?: AbortSignal;
  private hasUsedModel = false;

  constructor(
    readonly model: string,
    private readonly system: string,
    host: string = DEFAULT_HOST,
  ) {
    this.host = normalizeHost(host);

    const fetchWithSignal = (
      input: Parameters<typeof fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const extra = this.activeSignal;
      let signal = init.signal ?? undefined;
      if (extra) signal = signal ? AbortSignal.any([signal, extra]) : extra;
      return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        signal,
        dispatcher: noTimeoutAgent,
      }) as unknown as Promise<Response>;
    };

    this.client = new Ollama({ host: this.host, fetch: fetchWithSignal });
  }

  async chat(
    messages: Message[],
    tools: ToolSchema[],
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    this.activeSignal = signal;
    this.hasUsedModel = true;
    const toolCalls: ToolCall[] = [];
    let text = '';

    try {
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
        options: { num_ctx: NUM_CTX },
      });

      let truncated = false;
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
        if (part.done && part.done_reason === 'length') truncated = true;
      }

      if (truncated) onText('\n[truncated: hit the context limit]');
      return { text, toolCalls };
    } catch (err) {
      if (signal?.aborted) return { text, toolCalls };
      await logDiagnostic('provider.chat', err, {
        model: this.model,
        host: this.host,
        messages: messages.length,
      });
      throw new Error(describeError(err), { cause: err });
    } finally {
      this.activeSignal = undefined;
    }
  }

  /** Ask the Ollama daemon to unload this model without stopping the daemon. */
  async unload(): Promise<void> {
    if (!this.hasUsedModel) return;

    const response = await fetch(`${this.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: '',
        keep_alive: 0,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Ollama unload request failed: HTTP ${response.status}`);
    }

    // Consume the response body so the request is fully completed.
    await response.text();
  }
}

export async function checkOllama(
  model: string,
  host: string = DEFAULT_HOST,
): Promise<string | null> {
  try {
    const baseUrl = normalizeHost(host);
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