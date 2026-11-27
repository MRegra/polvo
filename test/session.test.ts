import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession, saveSession } from '../src/session.ts';

test('saveSession and loadSession round-trip per project cwd', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'polvo-session-'));
  assert.equal(loadSession('/proj/a', stateDir), null);

  saveSession('/proj/a', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], stateDir);
  const loaded = loadSession('/proj/a', stateDir);
  assert.ok(loaded);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0]?.content, 'hi');
  assert.equal(loadSession('/proj/b', stateDir), null);
});
