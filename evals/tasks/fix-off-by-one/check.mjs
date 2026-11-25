import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [dir] = process.argv.slice(2);
execFileSync('node', ['test.mjs'], { cwd: dir, stdio: 'pipe' });
if (!readFileSync(`${dir}/test.mjs`, 'utf8').includes('range(5, 5), [5]')) throw new Error('tests were changed');
