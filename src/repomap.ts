import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
]);

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const MAX_FILES = 200;
const MAX_SYMBOLS_PER_FILE = 12;

/**
 * Extract top-level / exported symbol names from JS/TS source without a full
 * parser, so the model can see where functions and types live before reading.
 */
export function extractSymbols(source: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined): void => {
    if (!name || seen.has(name) || names.length >= MAX_SYMBOLS_PER_FILE) return;
    seen.add(name);
    names.push(name);
  };

  for (const raw of source.split('\n')) {
    if (names.length >= MAX_SYMBOLS_PER_FILE) break;
    const line = raw.trimEnd();
    const exp = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (exp) {
      add(exp[1]);
      continue;
    }
    const top = /^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (top) add(top[1]);
  }
  return names;
}

/**
 * Compact list of project files and their top-level symbols, bounded by
 * `maxChars`, for the system prompt. Empty string when the directory has no files.
 */
export function buildRepoMap(root: string = process.cwd(), maxChars = 2_500): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.polvo.json') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(root);
  if (files.length === 0) return '';

  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < files.length; i++) {
    const full = files[i]!;
    const rel = relative(root, full).split(sep).join('/');
    let line = rel;
    if (CODE_EXTS.has(extname(full).toLowerCase())) {
      try {
        if (statSync(full).size <= 250_000) {
          const syms = extractSymbols(readFileSync(full, 'utf8'));
          if (syms.length) line += `: ${syms.join(', ')}`;
        }
      } catch {
        // unreadable file: keep path only
      }
    }
    const added = (lines.length ? 1 : 0) + line.length;
    if (used + added > maxChars) {
      lines.push(`… (+${files.length - i} more files)`);
      break;
    }
    lines.push(line);
    used += added;
  }
  return lines.join('\n');
}
