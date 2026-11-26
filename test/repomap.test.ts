import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoMap, extractSymbols } from '../src/repomap.ts';

test('extractSymbols captures exported and top-level symbols', () => {
  const src = [
    'export async function loadUser(id) {}',
    'export const PORT = 8137;',
    'export type Config = { port: number };',
    'function helper() {}',
    'class Store {}',
  ].join('\n');
  assert.deepEqual(extractSymbols(src), ['loadUser', 'PORT', 'Config', 'helper', 'Store']);
});

test('buildRepoMap lists files with symbols, skips ignored dirs, and caps length', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polvo-repomap-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  writeFileSync(join(dir, 'src', 'config.mjs'), 'export const port = 8137;\n');
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'export const ignored = 1;\n');
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');

  const map = buildRepoMap(dir);
  assert.match(map, /^README\.md$/m);
  assert.match(map, /^src\/config\.mjs: port$/m);
  assert.doesNotMatch(map, /node_modules|\.git/);

  const tiny = buildRepoMap(dir, 15);
  assert.match(tiny, /\(\+\d+ more files\)/);
});
