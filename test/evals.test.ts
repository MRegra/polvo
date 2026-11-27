import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck, formatComparison } from '../evals/run.ts';

const TASKS = join(import.meta.dirname, '..', 'evals', 'tasks');

for (const name of readdirSync(TASKS)) {
  test(`eval task ${name}: check fails as shipped, passes with the reference solution`, async () => {
    const task = JSON.parse(readFileSync(join(TASKS, name, 'task.json'), 'utf8')) as { prompt: string };
    assert.ok(task.prompt.length > 10);

    const before = mkdtempSync(join(tmpdir(), `polvo-eval-${name}-`));
    cpSync(join(TASKS, name, 'repo'), before, { recursive: true });
    writeFileSync(join(before, '.output'), '');
    assert.equal((await runCheck(join(TASKS, name), before)).pass, false, 'task is already solved as shipped');

    const after = mkdtempSync(join(tmpdir(), `polvo-eval-${name}-`));
    cpSync(join(TASKS, name, 'repo'), after, { recursive: true });
    cpSync(join(TASKS, name, 'solution'), after, { recursive: true });
    if (!existsSync(join(after, '.output'))) writeFileSync(join(after, '.output'), '');
    const r = await runCheck(join(TASKS, name), after);
    assert.equal(r.pass, true, r.reason);
  });
}

test('formatComparison reports deltas against previous eval run', () => {
  const prev = {
    model: 'm', numCtx: 16384, date: 'd1', passed: 1, total: 2, totalSteps: 10, totalSeconds: 100,
    results: [
      { task: 'a', pass: false, steps: 7, toolCalls: 6, toolErrors: 1, checksRun: 0, declined: [], durationS: 60 },
      { task: 'b', pass: true, steps: 3, toolCalls: 2, toolErrors: 0, checksRun: 0, declined: [], durationS: 40 },
    ],
  };
  const curr = {
    model: 'm', numCtx: 16384, date: 'd2', passed: 2, total: 2, totalSteps: 6, totalSeconds: 55,
    results: [
      { task: 'a', pass: true, steps: 3, toolCalls: 2, toolErrors: 0, checksRun: 0, declined: [], durationS: 20 },
      { task: 'b', pass: true, steps: 3, toolCalls: 2, toolErrors: 0, checksRun: 0, declined: [], durationS: 35 },
    ],
  };
  const out = formatComparison(prev, curr, 'prev-run');
  assert.match(out, /vs prev-run: passed 1\/2→2\/2 · steps 10→6 · time 100s→55s/);
  assert.match(out, /a: ✗→✓\s+steps 7→3\s+60s→20s/);
});
