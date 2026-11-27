import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCliArgs } from '../src/escalate.ts';

test('buildCliArgs builds read-only invocation for agy', () => {
  assert.deepEqual(buildCliArgs('agy', 'explain auth'), {
    cmd: 'agy',
    args: ['-p', '--mode', 'plan', '--output-format', 'text', 'explain auth'],
  });
});
