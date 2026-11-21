import Anthropic from '@anthropic-ai/sdk';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A model backend. Everything the agent needs from an LLM goes through this
 * interface, so swapping Anthropic for a local model later is a new class —
 * not a rewrite of the REPL.
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

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private client: Anthropic | undefined;

  constructor(
    readonly model: string,
    private readonly system: string,
  ) {}

  // Lazy so construction never throws when no credentials are present;
  // the auth error then surfaces on the first request, where it is caught.
  private getClient(): Anthropic {
    return (this.client ??= new Anthropic());
  }

  async stream(
    messages: Message[],
    onText: (delta: string) => void,
  ): Promise<string> {
    const stream = this.getClient().messages.stream({
      model: this.model,
      max_tokens: 8192,
      system: this.system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    stream.on('text', (delta) => onText(delta));

    const final = await stream.finalMessage();
    return final.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
}
