import * as readline from 'node:readline';
import type { Message, Provider } from './provider.js';
import * as ui from './ui.js';

/**
 * The agent loop, v0.0.1 edition: read a line, send the whole conversation to
 * the model, stream the reply, repeat. No tools yet — this is the skeleton
 * every later increment hangs off.
 *
 * Input is LOCKED while a reply is generating: keystrokes are neither echoed
 * nor queued, so you can't type into a turn that is still being produced. On a
 * real terminal this means raw mode (no echo) + a drain of anything typed; a
 * `busy` guard ignores any line that still slips through.
 *
 * Invariant: every user turn stored in `messages` is followed by a real
 * assistant reply. A failed or empty turn is dropped so a bad history can't
 * wedge the session.
 */
export function runRepl(provider: Provider): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    const messages: Message[] = [];
    const canRaw =
      process.stdin.isTTY === true &&
      typeof process.stdin.setRawMode === 'function';
    let busy = false;
    let activeTurn: Promise<void> | null = null;

    const prompt = (): void => {
      process.stdout.write(ui.youPrompt);
    };

    const lockInput = (): void => {
      rl.pause();
      if (canRaw) process.stdin.setRawMode(true); // disable terminal echo
    };

    const unlockInput = (): void => {
      if (canRaw) {
        process.stdin.setRawMode(false);
        // discard whatever was typed while the reply was generating
        while (process.stdin.read() !== null) {
          /* drop */
        }
      }
      rl.resume();
    };

    process.stdout.write(ui.banner(provider.model));
    prompt();

    rl.on('line', (line) => {
      if (busy) return; // ignore input that arrives mid-generation
      activeTurn = handleLine(line);
    });
    rl.on('close', () => {
      void finish();
    });

    async function finish(): Promise<void> {
      if (activeTurn) {
        try {
          await activeTurn; // let an in-flight reply finish before saying bye
        } catch {
          /* turn errors are handled inside handleLine */
        }
      }
      process.stdout.write('\n' + ui.dim('bye 🐙') + '\n');
      resolve();
    }

    async function handleLine(line: string): Promise<void> {
      if (busy) return; // ignore input that arrives mid-generation
      const input = line.trim();
      if (input === '') {
        prompt();
        return;
      }
      if (input === '/exit' || input === '/quit') {
        rl.close();
        return;
      }

      busy = true;
      lockInput();
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
      } finally {
        unlockInput();
        process.stdout.write('\n');
        prompt();
        busy = false; // last, so a line emitted during unlock is still ignored
      }
    }
  });
}
