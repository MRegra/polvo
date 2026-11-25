import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [dir] = process.argv.slice(2);
execFileSync('node', ['test.mjs'], { cwd: dir, stdio: 'pipe' });
assert.ok(readFileSync(`${dir}/test.mjs`, 'utf8').includes("parseDuration('1h0m1s'), 3601"), 'tests were changed');
const { parseDuration } = await import(pathToFileURL(`${dir}/duration.mjs`).href);
assert.equal(parseDuration('3h'), 10800); // hidden case
assert.throws(() => parseDuration('5x'));
