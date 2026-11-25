import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const [dir] = process.argv.slice(2);
assert.deepEqual(JSON.parse(readFileSync(`${dir}/settings.json`, 'utf8')), {
  name: 'demo', retries: 3, features: ['search', 'export'], timeouts: { connect: 5, read: 30 },
});
