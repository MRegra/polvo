import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAutoApproved, parseCommand, runArgv } from '../src/command.ts';

test('parseCommand splits quotes and rejects shell syntax', () => {
  assert.deepEqual(parseCommand(`grep -rn "foo bar" 'src/*.ts'`), ['grep', '-rn', 'foo bar', 'src/*.ts']);
  for (const bad of ['ls; rm -rf /', 'cat a | sh', 'echo $(id)', 'echo `id`', 'ls > out', 'a && b', 'ls *.ts', 'cat ~/.ssh/id_rsa', 'echo $HOME', 'ls\nrm x']) {
    assert.throws(() => parseCommand(bad), undefined, bad);
  }
});

test('isAutoApproved: only known flags on files inside the project run without asking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polvo-cmd-'));
  writeFileSync(join(dir, 'a.txt'), 'x');
  symlinkSync('/etc/hostname', join(dir, 'link'));
  const ok = (line: string) => isAutoApproved(parseCommand(line), dir);
  for (const yes of ['ls', 'ls -la', 'cat a.txt', 'head -n5 a.txt', 'head -n 5 a.txt', 'cat /proc/meminfo',
    'ps aux', 'ps -eo pid,rss,comm', 'systemctl --failed', 'systemctl status sshd', 'journalctl -p err -n 5',
    "grep -rn foo .", "find . -name '*.ts' -type f", 'free -h', 'df -h /', 'ollama ps']) {
    assert.equal(ok(yes), true, yes);
  }
  // Each of these must ask: unknown flags, glued/abbreviated values, paths outside, risky /proc files.
  for (const no of ['rm a.txt', 'npm test', './script.sh', '/bin/ls', 'cat /etc/passwd', 'cat ../x', 'cat link', 'cat -',
    'cat /proc/self/environ', 'cat /proc/1/cmdline', 'ls -R /',
    'sort -uo/tmp/x a.txt', 'sort --outp=a.txt a.txt', 'uniq a.txt b.txt',
    'date -f/etc/hostname', 'date -s 2020-01-01', 'file -f/etc/hostname', 'grep -f /etc/hostname x', 'grep -f/etc/hostname x',
    'rg --pre=x foo', 'du -X/etc/hostname', 'find . -delete', 'find . -exec rm', 'find . -newer /etc/hostname',
    'tail -f a.txt', 'tail -fn5 a.txt', 'ps auxe', 'ps e',
    'systemctl --user -p status set-environment X=1', 'systemctl restart sshd', 'systemctl -Hhost status',
    'journalctl --vacuum-size=1M', 'journalctl --vac=1M', 'ollama rm model',
    'grep -R foo .', 'rg -L foo', 'diff -r a b', 'git push', 'git -c core.pager=x status', 'git diff --output=x', 'git blame a.txt']) {
    assert.equal(ok(no), false, no);
  }
});

test('git runs unasked only when the repo-local config is inert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polvo-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(isAutoApproved(['git', 'status'], dir), true);
  assert.equal(isAutoApproved(['git', 'diff', '--stat'], dir), true);
  // A repo-defined filter driver would run during diff/status: ask instead.
  execFileSync('git', ['config', 'filter.x.clean', 'cat'], { cwd: dir });
  assert.equal(isAutoApproved(['git', 'status'], dir), false);
  assert.equal(isAutoApproved(['git', 'diff', '--stat'], dir), false);
});

test('runArgv runs without a shell and kills the whole tree on timeout', async () => {
  const r = await runArgv(['echo', 'a;b']);
  assert.equal(r.output.trim(), 'a;b');
  const started = Date.now();
  const t = await runArgv(['sh', '-c', 'sleep 30 & sleep 30; wait'], { timeoutMs: 300 });
  assert.equal(t.timedOut, true);
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(runArgv(['definitely-not-a-program-xyz']), /command not found/);
});

test('a check that backgrounds a process leaves nothing running', async () => {
  const { runCheck } = await import('../src/checks.ts');
  const r = await runCheck('sleep 37.25 >/dev/null 2>&1 &');
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 200));
  const left = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('sleep 37.25'));
  assert.deepEqual(left, []);
});
