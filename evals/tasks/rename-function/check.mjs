import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const [dir] = process.argv.slice(2);
assert.equal(execFileSync('node', ['main.mjs'], { cwd: dir, encoding: 'utf8' }), '8\nTotal: 8.00\n');
for (const f of ['main.mjs', 'lib/total.mjs', 'lib/report.mjs']) {
  const src = readFileSync(`${dir}/${f}`, 'utf8');
  assert.ok(!src.includes('calc_total'), `${f} still mentions calc_total`);
}
assert.ok(readFileSync(`${dir}/lib/total.mjs`, 'utf8').includes('export function calculateTotal'));
