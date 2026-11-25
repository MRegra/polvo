import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../evals/run.ts';

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
