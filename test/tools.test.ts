import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, utimesSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, resetReadState } from '../src/tools.ts';

const run = (name: string, args: Record<string, unknown>) => TOOLS[name]!.run(args);

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), 'polvo-tools-')));
  resetReadState();
});

test('edit_file requires a read first', async () => {
  writeFileSync('a.txt', 'hello world\n');
  await assert.rejects(run('edit_file', { path: 'a.txt', old_string: 'hello', new_string: 'bye' }), /read a.txt/);
  await run('read_file', { path: 'a.txt' });
  assert.match(await run('edit_file', { path: 'a.txt', old_string: 'hello', new_string: 'bye' }), /1 replacement/);
  assert.equal(readFileSync('a.txt', 'utf8'), 'bye world\n');
});

test('edit_file refuses ambiguous and missing matches, honours replace_all', async () => {
  writeFileSync('a.txt', 'x = 1\nx = 1\n');
  await run('read_file', { path: 'a.txt' });
  await assert.rejects(run('edit_file', { path: 'a.txt', old_string: 'x = 1', new_string: 'x = 2' }), /occurs 2 times/);
  await assert.rejects(run('edit_file', { path: 'a.txt', old_string: 'y = 1', new_string: 'y = 2' }), /not found/);
  await run('edit_file', { path: 'a.txt', old_string: 'x = 1', new_string: 'x = 2', replace_all: true });
  assert.equal(readFileSync('a.txt', 'utf8'), 'x = 2\nx = 2\n');
});

test('edit_file keeps $ patterns literal and handles CRLF files', async () => {
  writeFileSync('a.txt', 'a\r\nb\r\nc\r\n');
  await run('read_file', { path: 'a.txt' });
  await run('edit_file', { path: 'a.txt', old_string: 'a\nb', new_string: '$&\n$1' });
  assert.equal(readFileSync('a.txt', 'utf8'), '$&\r\n$1\r\nc\r\n');
});

test('edits refuse a file that changed since it was read', async () => {
  writeFileSync('a.txt', 'one\n');
  await run('read_file', { path: 'a.txt' });
  writeFileSync('a.txt', 'two\n');
  utimesSync('a.txt', new Date(), new Date(Date.now() + 5000));
  await assert.rejects(run('edit_file', { path: 'a.txt', old_string: 'two', new_string: '3' }), /changed on disk/);
});

test('write_file creates freely but overwriting needs a read', async () => {
  assert.match(await run('write_file', { path: 'new.txt', content: 'hi' }), /created/);
  writeFileSync('old.txt', 'keep');
  await assert.rejects(run('write_file', { path: 'old.txt', content: 'gone' }), /read old.txt/);
  mkdirSync('.git');
  await assert.rejects(run('write_file', { path: '.git/config', content: 'x' }), /\.git/);
  await assert.rejects(run('write_file', { path: '../escape.txt', content: 'x' }), /escapes/);
});

test('read_file pages long files and write_file refuses a page back', async () => {
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`).join('\n');
  writeFileSync('big.txt', big);
  const page1 = await run('read_file', { path: 'big.txt' });
  const m = /start_line=(\d+)/.exec(page1);
  assert.ok(m, 'first page ends with a continuation hint');
  const page2 = await run('read_file', { path: 'big.txt', start_line: Number(m[1]) });
  assert.ok(page2.startsWith(`line ${m[1]} `));
  await assert.rejects(run('write_file', { path: 'big.txt', content: page1 }), /page marker/);
});

test('edits keep the file mode', async () => {
  writeFileSync('run.sh', 'echo hi\n');
  chmodSync('run.sh', 0o750);
  await run('read_file', { path: 'run.sh' });
  await run('edit_file', { path: 'run.sh', old_string: 'hi', new_string: 'bye' });
  assert.equal(statSync('run.sh').mode & 0o777, 0o750);
});
