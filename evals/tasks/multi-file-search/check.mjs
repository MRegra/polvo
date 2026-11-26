import { readFileSync } from 'node:fs';
const [, output] = process.argv.slice(2);
const text = readFileSync(output, 'utf8');
if (!/\b2750\b/.test(text)) throw new Error(`answer was: ${text.slice(0, 200)}`);
