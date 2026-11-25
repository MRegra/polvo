import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [dir] = process.argv.slice(2);
const s = await import(pathToFileURL(`${dir}/shapes.mjs`).href);
assert.equal(s.triangleArea(4, 3), 6);
assert.equal(s.rectangleArea(4, 3), 12);
assert.equal(s.parallelogramArea(4, 3), 12);
