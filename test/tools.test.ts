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

test('write_file refuses to blank out an existing file', async () => {
  writeFileSync('cfg.json', '{"a": 1}');
  await run('read_file', { path: 'cfg.json' });
  await assert.rejects(run('write_file', { path: 'cfg.json', content: '' }), /empty content/);
  await assert.rejects(run('write_file', { path: 'cfg.json', content: '  \n' }), /empty content/);
  assert.equal(readFileSync('cfg.json', 'utf8'), '{"a": 1}');
  assert.match(await run('write_file', { path: 'new-empty.txt', content: '' }), /created/);
});

test('edits that break JavaScript or JSON syntax are refused, file untouched', async () => {
  writeFileSync('ok.mjs', 'export const add = (a, b) => a + b;\n');
  await run('read_file', { path: 'ok.mjs' });
  await assert.rejects(
    run('edit_file', { path: 'ok.mjs', old_string: 'a + b;', new_string: 'a + (b;' }),
    /syntax error[\s\S]*SyntaxError/,
  );
  assert.equal(readFileSync('ok.mjs', 'utf8'), 'export const add = (a, b) => a + b;\n');
  assert.match(await run('edit_file', { path: 'ok.mjs', old_string: 'a + b', new_string: 'b + a' }), /edited/);

  await assert.rejects(run('write_file', { path: 'new.js', content: 'function (' }), /syntax error/);
  await assert.rejects(run('write_file', { path: 'new.json', content: '{"a": 1,}' }), /syntax error/);
  assert.match(await run('write_file', { path: 'tsconfig.json', content: '{ // comments are fine here\n}' }), /created/);
  assert.match(await run('write_file', { path: 'notes.txt', content: 'function (' }), /created/);
});

test('a file that was already broken can still be edited, with a warning', async () => {
  writeFileSync('broken.json', '{"a": 1,, "b": 2,}');
  await run('read_file', { path: 'broken.json' });
  const r = await run('edit_file', { path: 'broken.json', old_string: '1,,', new_string: '1,' });
  assert.match(r, /edited[\s\S]*still does not parse/);
  await run('read_file', { path: 'broken.json' });
  assert.doesNotMatch(await run('edit_file', { path: 'broken.json', old_string: '2,}', new_string: '2}' }), /warning/);
});

test('a missed edit shows the closest lines, and spots an already-applied change', async () => {
  writeFileSync('f.mjs', 'export function area(b, h) {\n    return b * h;\n}\n');
  await run('read_file', { path: 'f.mjs' });
  await assert.rejects(
    run('edit_file', { path: 'f.mjs', old_string: 'export function area(b, h) {\n  return b * h;', new_string: 'x' }),
    /except for whitespace[\s\S]*2:     return b \* h;/,
  );
  await assert.rejects(
    run('edit_file', { path: 'f.mjs', old_string: 'export function area(b, h) {\n  return b + h;', new_string: 'x' }),
    /Closest match in the file \(1 of 2 lines\)[\s\S]*1: export function area/,
  );
  await assert.rejects(
    run('edit_file', { path: 'f.mjs', old_string: 'return b + h;', new_string: 'return b * h;' }),
    /already there/,
  );
});

test('grep searches files with line numbers, glob filter, and ignores node_modules/.git', async () => {
  mkdirSync('src');
  mkdirSync('node_modules/pkg', { recursive: true });
  writeFileSync('src/a.ts', 'const port = 8137;\n');
  writeFileSync('src/b.md', 'port = 3000\n');
  writeFileSync('node_modules/pkg/c.ts', 'const port = 9999;\n');

  const all = await run('grep', { pattern: 'PORT' });
  assert.match(all, /^src\/a\.ts:1: const port = 8137;$/m);
  assert.match(all, /^src\/b\.md:1: port = 3000$/m);
  assert.doesNotMatch(all, /node_modules/);

  assert.match(await run('grep', { pattern: 'PORT', case_sensitive: true }), /no matches/);

  const onlyTs = await run('grep', { pattern: 'port', glob: '*.ts' });
  assert.match(onlyTs, /src\/a\.ts:1:/);
  assert.doesNotMatch(onlyTs, /src\/b\.md/);

  assert.match(await run('grep', { pattern: 'not_anywhere' }), /no matches/);
  await assert.rejects(run('grep', { pattern: 'x', path: '..' }), /escapes/);
});

test('read_file supports end_line ranges', async () => {
  writeFileSync('lines.txt', 'one\ntwo\nthree\nfour\nfive\n');
  assert.equal(await run('read_file', { path: 'lines.txt', start_line: 2, end_line: 4 }), 'two\nthree\nfour');
  await assert.rejects(run('read_file', { path: 'lines.txt', start_line: 4, end_line: 2 }), /end_line/);
});

test('leading slash for a project file hints to drop the slash', async () => {
  mkdirSync('lib');
  writeFileSync('lib/total.mjs', 'export const x = 1;\n');
  await assert.rejects(
    run('read_file', { path: '/lib/total.mjs' }),
    /drop the leading "\/" to use the project-relative path "lib\/total\.mjs"/,
  );
  await assert.rejects(run('read_file', { path: '/etc/passwd' }), /escapes the working directory/);
});
