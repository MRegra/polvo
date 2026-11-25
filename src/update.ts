import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readVersion } from './version.js';

/**
 * `polvo update`: fast-forward the checkout polvo runs from and rebuild it.
 * polvo is installed with `npm link`, so the global command points into this
 * checkout's dist/ and a rebuild is all an update needs. It refuses to touch
 * a checkout with local changes or on another branch — that's someone's work.
 */

export const UPDATE_BRANCH = 'master';

export interface UpdateOptions {
  /** Only fetch and report; change nothing. */
  check?: boolean;
  /** Install deps and build (injectable so tests can skip npm). */
  build?: (dir: string) => void;
  log?: (line: string) => void;
}

export type UpdateResult =
  | { status: 'up-to-date'; version: string }
  | { status: 'available'; behind: number; version: string }
  | { status: 'updated'; from: string; to: string; commits: number };

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function npmBuild(dir: string): void {
  // stdio inherited: npm's progress and errors go straight to the terminal.
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: dir, stdio: 'inherit' });
}

/** Throws with a message saying what to do when the checkout can't be updated safely. */
export function assertUpdatable(dir: string): void {
  let pkgName: unknown;
  try {
    pkgName = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    pkgName = undefined;
  }
  if (pkgName !== 'polvo') throw new Error(`${dir} is not a polvo checkout`);
  let top: string;
  try {
    top = git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(`${dir} is not a git checkout — reinstall with scripts/install.sh`);
  }
  if (resolve(top) !== resolve(dir)) throw new Error(`${dir} is not the root of its git checkout`);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== UPDATE_BRANCH) {
    throw new Error(`${dir} is on branch "${branch}", not ${UPDATE_BRANCH} — switch with: git -C ${dir} checkout ${UPDATE_BRANCH}`);
  }
  // Untracked files (eval results, scratch notes) don't block a fast-forward;
  // git itself refuses if one would be overwritten. Only real edits do.
  if (git(dir, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error(`${dir} has uncommitted changes — commit or stash them first (git -C ${dir} status)`);
  }
}

export function update(dir: string, options: UpdateOptions = {}): UpdateResult {
  const { check = false, build = npmBuild, log = () => {} } = options;
  assertUpdatable(dir);

  log(`fetching ${UPDATE_BRANCH} …`);
  git(dir, ['fetch', '--quiet', 'origin', UPDATE_BRANCH]);
  const behind = Number(git(dir, ['rev-list', '--count', `HEAD..origin/${UPDATE_BRANCH}`]));
  const version = readVersion(dir);

  if (check) return behind > 0 ? { status: 'available', behind, version } : { status: 'up-to-date', version };
  if (behind === 0) {
    // Nothing new, but repair a missing build (e.g. dist/ was deleted).
    if (!existsSync(join(dir, 'dist', 'index.js'))) build(dir);
    return { status: 'up-to-date', version };
  }

  const before = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['merge', '--ff-only', '--quiet', `origin/${UPDATE_BRANCH}`]);
  log(`pulled ${behind} commit${behind === 1 ? '' : 's'}; installing and building …`);
  try {
    build(dir);
  } catch (err) {
    // Roll back so the installed command keeps working on the old code.
    git(dir, ['reset', '--hard', '--quiet', before]);
    try {
      build(dir);
    } catch {
      // best effort; report the original failure
    }
    throw new Error(`build failed, rolled back to ${before.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { status: 'updated', from: version, to: readVersion(dir), commits: behind };
}
