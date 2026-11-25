import { spawn } from 'node:child_process';
import { capOutput } from './context.js';
import { killTreeAfter } from './command.js';

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

/**
 * Run one project check (from .polvo.json). These are the user's own commands,
 * so they go through `sh -c` (pipes and && allowed) — but only after the user
 * approved them for this session (agent.ts), since a cloned repo can ship a
 * .polvo.json too.
 */
export function runCheck(
  command: string,
  { cwd = process.cwd(), timeoutMs = 300_000 }: { cwd?: string; timeoutMs?: number } = {},
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so a timeout kills npm → tsc too
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const kill = killTreeAfter(child, timeoutMs);
    let out = '';
    const take = (d: Buffer): void => {
      out += d.toString('utf8');
      if (out.length > 200_000) out = out.slice(-100_000); // keep the tail: errors land last
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => {
      clearTimeout(kill.timer);
      resolve({ command, ok: false, exitCode: null, output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(kill.timer);
      const timedOut = kill.fired();
      resolve({
        command,
        ok: code === 0,
        exitCode: code,
        output: capOutput(timedOut ? `${out}\n[timed out after ${timeoutMs / 1000} s]` : out, 6_000),
      });
    });
  });
}

export async function runChecks(commands: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  // Sequential: checks often share build output, and the first failure is the useful one.
  for (const c of commands) results.push(await runCheck(c));
  return results;
}

/** The message fed back to the model when checks fail. */
export function failureReport(failed: CheckResult[]): string {
  const parts = failed.map((r) => `$ ${r.command}  (exit ${r.exitCode ?? 'killed'})\n${r.output.trim()}`);
  return `[polvo] The project checks failed after your changes:\n\n${parts.join('\n\n')}\n\nFix the cause of these failures. Do not weaken or delete the checks or tests to make them pass.`;
}
