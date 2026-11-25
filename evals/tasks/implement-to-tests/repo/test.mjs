import assert from 'node:assert/strict';
import { parseDuration } from './duration.mjs';
assert.equal(parseDuration('45s'), 45);
assert.equal(parseDuration('2m5s'), 125);
assert.equal(parseDuration('1h30m'), 5400);
assert.equal(parseDuration('1h0m1s'), 3601);
assert.throws(() => parseDuration('soon'));
assert.throws(() => parseDuration(''));
console.log('ok');
