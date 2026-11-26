import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, detectChecks, DEFAULTS } from '../src/config.ts';

test('defaults, then .polvo.json, then env, then CLI', () => {
  assert.equal(loadConfig(undefined, {}, {}).numCtx, DEFAULTS.numCtx);
  assert.equal(loadConfig(undefined, {}, { numCtx: 8192 }).numCtx, 8192);
  assert.equal(loadConfig(undefined, { POLVO_NUM_CTX: '4096' }, { numCtx: 8192 }).numCtx, 4096);
  assert.equal(loadConfig('cli-model', { POLVO_MODEL: 'env-model' }, { model: 'file-model' }).model, 'cli-model');
});

test('rejects bad values instead of guessing', () => {
  assert.throws(() => loadConfig(undefined, { POLVO_NUM_CTX: 'lots' }, {}), /positive integer/);
  assert.throws(() => loadConfig(undefined, { POLVO_KEEP_ALIVE: 'forever' }, {}), /keepAlive/);
  assert.throws(() => loadConfig(undefined, {}, { checks: 'npm test' }), /checks/);
  assert.throws(() => loadConfig(undefined, {}, { options: { temperature: 'hot' } }), /temperature/);
  assert.throws(() => loadConfig(undefined, {}, { options: { num_predict: 0 } }), /num_predict/);
  assert.equal(loadConfig(undefined, { POLVO_KEEP_ALIVE: '-1' }, {}).keepAlive, '-1');
  assert.deepEqual(
    loadConfig(undefined, {}, { options: { temperature: 0.2, top_p: 0.9, num_predict: 2048 } }).modelOptions,
    { temperature: 0.2, top_p: 0.9, num_predict: 2048 },
  );
});

test('detectChecks infers typecheck and test scripts from package.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polvo-checks-'));
  assert.deepEqual(detectChecks(dir), []);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }),
  );
  assert.deepEqual(detectChecks(dir), ['npm run typecheck', 'npm test']);
});
