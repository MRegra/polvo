import { readFileSync } from 'node:fs';
const [, output] = process.argv.slice(2);
const text = readFileSync(output, 'utf8');
if (!/\b8137\b/.test(text)) throw new Error(`answer was: ${text.slice(0, 200)}`);
if (/\b3000\b/.test(text)) throw new Error('mentions the stale port 3000');
