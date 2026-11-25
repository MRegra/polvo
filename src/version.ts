import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checkout polvo runs from: one level above src/ (tsx) or dist/ (built). */
export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read the version from package.json, so a release bumps exactly one place. */
export function readVersion(dir: string = REPO_DIR): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();
