import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { update } from '../src/update.ts';

// Commits need an identity; CI runners have none configured.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
});
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const pkg = (version: string) => JSON.stringify({ name: 'polvo', version }, null, 2) + '\n';

let origin: string; // bare "GitHub"
let upstream: string; // where new releases get committed
let install: string; // the user's checkout polvo runs from

function release(version: string): void {
  writeFileSync(join(upstream, 'package.json'), pkg(version));
  git(upstream, 'commit', '-qam', `v${version}`);
  git(upstream, 'push', '-q', 'origin', 'master');
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'polvo-update-'));
  origin = join(root, 'origin.git');
  upstream = join(root, 'upstream');
  install = join(root, 'install');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  git(root, 'clone', '-q', origin, upstream);
  git(upstream, 'checkout', '-q', '-b', 'master');
  writeFileSync(join(upstream, 'package.json'), pkg('1.0.0'));
  writeFileSync(join(upstream, '.gitignore'), 'dist/\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-qm', 'init');
  git(upstream, 'push', '-q', 'origin', 'master');
  git(root, 'clone', '-q', origin, install);
});

const builds: string[] = [];
const fakeBuild = (dir: string) => builds.push(readFileSync(join(dir, 'package.json'), 'utf8'));

test('fast-forwards, rebuilds and reports the new version', () => {
  release('1.1.0');
  assert.deepEqual(update(install, { check: true, build: fakeBuild }), { status: 'available', behind: 1, version: '1.0.0' });
  const r = update(install, { build: fakeBuild });
  assert.deepEqual(r, { status: 'updated', from: '1.0.0', to: '1.1.0', commits: 1 });
  assert.match(builds.at(-1)!, /1\.1\.0/);
  assert.equal(update(install, { build: fakeBuild }).status, 'up-to-date');
});

test('up to date still repairs a missing build', () => {
  builds.length = 0;
  assert.equal(existsSync(join(install, 'dist', 'index.js')), false);
  assert.equal(update(install, { build: fakeBuild }).status, 'up-to-date');
  assert.equal(builds.length, 1);
});

test('untracked files (e.g. eval results) do not block an update', () => {
  release('1.2.0');
  writeFileSync(join(install, 'eval-result.json'), '{}');
  assert.equal(update(install, { build: fakeBuild }).status, 'updated');
});

test('refuses local changes, other branches, and non-polvo directories', () => {
  writeFileSync(join(install, 'package.json'), pkg('9.9.9'));
  assert.throws(() => update(install, { build: fakeBuild }), /uncommitted changes/);
  git(install, 'checkout', '-q', '--', 'package.json');
  git(install, 'checkout', '-q', '-b', 'feature');
  assert.throws(() => update(install, { build: fakeBuild }), /on branch "feature"/);
  assert.throws(() => update(tmpdir(), { build: fakeBuild }), /not a polvo checkout/);
});

test('a failed build rolls back to the previous commit', () => {
  release('2.0.0');
  const before = git(install, 'rev-parse', 'HEAD');
  let calls = 0;
  const flaky = () => {
    if (calls++ === 0) throw new Error('tsc exploded');
  };
  assert.throws(() => update(install, { build: flaky }), /build failed, rolled back.*tsc exploded/);
  assert.equal(git(install, 'rev-parse', 'HEAD'), before);
  assert.equal(calls, 2, 'rebuilt the old version after rolling back');
});
