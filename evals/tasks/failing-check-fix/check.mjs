import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [dir] = process.argv.slice(2);
execFileSync('node', ['test.mjs'], { cwd: dir, stdio: 'pipe' });
assert.ok(readFileSync(`${dir}/test.mjs`, 'utf8').includes("slugify('---'), ''"), 'tests were changed');
const { slugify } = await import(pathToFileURL(`${dir}/slug.mjs`).href);
assert.equal(slugify('foo_bar!'), 'foo-bar');
