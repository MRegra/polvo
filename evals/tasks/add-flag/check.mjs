import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [dir] = process.argv.slice(2);
const run = (...a) => execFileSync('node', ['cli.mjs', ...a], { cwd: dir, encoding: 'utf8' }).trim();
assert.equal(run('bob'), 'Hello, bob!');
assert.equal(run('--shout', 'bob'), 'HELLO, BOB!');
assert.equal(run('bob', '--shout'), 'HELLO, BOB!');
