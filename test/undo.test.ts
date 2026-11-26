import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnSnapshot } from '../src/undo.ts';

test('TurnSnapshot restores modified files and deletes newly created ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polvo-undo-'));
  writeFileSync(join(dir, 'existing.txt'), 'before\n');

  const snap = new TurnSnapshot(dir);
  snap.capture('existing.txt');
  snap.capture('created.txt');
  // Second capture of the same file must keep the original bytes, not the edit.
  writeFileSync(join(dir, 'existing.txt'), 'after\n');
  snap.capture('existing.txt');
  writeFileSync(join(dir, 'created.txt'), 'new file\n');

  assert.equal(snap.hasChanges(), true);
  const restored = snap.restore();
  assert.deepEqual(restored, ['created.txt', 'existing.txt']);
  assert.equal(readFileSync(join(dir, 'existing.txt'), 'utf8'), 'before\n');
  assert.equal(existsSync(join(dir, 'created.txt')), false);
  assert.equal(snap.hasChanges(), false);
});
