import * as readline from 'node:readline';
import type { Message, Provider } from './provider.js';
import * as ui from './ui.js';

/**
 * The agent loop, v0.0.1 edition: read a line, send the whole conversation to
 * the model, stream the reply, repeat. No tools yet — this is the skeleton
 * every later increment hangs off.
 *
 * Invariant: every user turn stored in `messages` is followed by a real
 * assistant reply. If a turn fails or comes back empty, we drop the user turn
 * so a poisoned history can't wedge the session.
 */
export async function runRepl(provider: Provider): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const messages: Message[] = [];

  process.stdout.write(ui.banner(provider.model));
  process.stdout.write(ui.youPrompt);

  for await (const line of rl) {
    const input = line.trim();
    if (input === '') {
      process.stdout.write(ui.youPrompt);
      continue;
    }
    if (input === '/exit' || input === '/quit') break;

    messages.push({ role: 'user', content: input });
    process.stdout.write('\n' + ui.assistantLabel);

    try {
      const reply = await provider.stream(messages, (delta) =>
        process.stdout.write(delta),
      );
      if (reply.trim() === '') {
        // Nothing usable came back — drop the user turn rather than store an
        // empty assistant reply that would corrupt the history.
        messages.pop();
        process.stdout.write('\n');
        process.stderr.write(ui.errorLine('empty reply from model') + '\n');
      } else {
        messages.push({ role: 'assistant', content: reply });
        process.stdout.write('\n');
      }
    } catch (err) {
      messages.pop();
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write('\n');
      process.stderr.write(ui.errorLine(msg) + '\n');
    }

    process.stdout.write('\n' + ui.youPrompt);
  }

  rl.close();
  process.stdout.write('\n' + ui.dim('bye 🐙') + '\n');
}
