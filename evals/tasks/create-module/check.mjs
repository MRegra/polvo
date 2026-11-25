import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [dir] = process.argv.slice(2);
const { slugify } = await import(pathToFileURL(`${dir}/slugify.mjs`).href);
assert.equal(slugify('  Hello, World! '), 'hello-world');
assert.equal(slugify('a--b__c'), 'a-b-c');
assert.equal(slugify('---'), '');
assert.equal(slugify('Polvo 2 Go'), 'polvo-2-go');
