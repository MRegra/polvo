import { execFile } from 'node:child_process';

export type ExternalCli = 'agy';

export function buildCliArgs(cli: ExternalCli, prompt: string): { cmd: string; args: string[] } {
  return { cmd: cli, args: ['-p', '--mode', 'plan', '--output-format', 'text', prompt] };
}

/**
 * Escalate a read-only question or planning prompt to the Antigravity CLI (`agy`)
 * so the user can leverage cloud quota from inside polvo.
 */
export function askExternalCli(
  cli: ExternalCli,
  prompt: string,
  cwd: string = process.cwd(),
  timeoutMs = 120_000,
): Promise<string> {
  const { cmd, args } = buildCliArgs(cli, prompt);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 2_000_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || String(err)).trim();
        return reject(new Error(`${cli} failed: ${msg.slice(0, 300)}`));
      }
      resolve(stdout.trim() || '(empty response)');
    });
  });
}
