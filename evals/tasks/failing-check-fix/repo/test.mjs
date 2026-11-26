import assert from 'node:assert/strict';
import { slugify } from './slug.mjs';
assert.equal(slugify('  Hello, World!  '), 'hello-world');
assert.equal(slugify('a---b'), 'a-b');
assert.equal(slugify('Polvo 2 Go'), 'polvo-2-go');
assert.equal(slugify('---'), '');
console.log('ok');
