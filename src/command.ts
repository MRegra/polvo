import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { capOutput } from './context.js';

/**
 * run_command never uses a shell: the line is split into argv and handed to
 * spawn, so `;`, `|`, `$(…)` and friends can't chain extra programs. Shell
 * syntax is rejected up front with a clear message instead of being passed as
 * literal text the model didn't mean.
 */
export function parseCommand(line: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (ch === '\n' || ch === '\r') throw new Error('one command per call — no newlines');
      if (hasToken) argv.push(cur);
      cur = '';
      hasToken = false;
    } else if (';|&<>`$(){}'.includes(ch)) {
      throw new Error(
        `shell syntax "${ch}" is not supported — there is no shell. Run one program per call (no pipes, redirects, && or $VARS); quote the character if it is a literal argument.`,
      );
    } else if (ch === '*' || ch === '?') {
      throw new Error(`no glob expansion — quote "${ch}" if it is a pattern for the program (e.g. find -name '*.ts')`);
    } else if (ch === '~' && !hasToken) {
      throw new Error('no ~ expansion — use a path relative to the project or an absolute path');
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      hasToken = true;
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (quote) throw new Error('unterminated quote');
  if (hasToken) argv.push(cur);
  if (argv.length === 0) throw new Error('empty command');
  return argv;
}

type Value = 'num' | 'text' | 'path';

/**
 * What a program may be given and still run without asking. An ALLOWLIST: a
 * flag that isn't listed means "ask the user". Deny-lists don't hold up —
 * GNU tools accept abbreviated long options (--compress-prog), clustered short
 * flags (-uo/file) and glued values (-f/file), so every flag must be known.
 */
interface Spec {
  /** Short boolean flags; may be clustered (-la). */
  bool?: string;
  /** Short flags that take a value, glued (-n5) or separate (-n 5). */
  short?: Record<string, Value>;
  /** Long flags, exact names only: null = boolean, else its value type. */
  long?: Record<string, Value | null>;
  /** Positional args: files to read (checked), free text, or none allowed. */
  positional: Value | 'none';
  /** Extra rule over the positionals, e.g. allowed subcommands. */
  check?: (positionals: string[]) => boolean;
}

const GREP_LONG = { '--include': 'text', '--exclude': 'text', '--exclude-dir': 'text', '--color': 'text' } as const;

const SPECS: Record<string, Spec> = {
  ls: { bool: 'alhRtrS1dFA', long: { '--all': null, '--color': 'text' }, positional: 'path' },
  cat: { bool: 'nAbEsTv', positional: 'path' },
  head: { short: { n: 'num', c: 'num' }, positional: 'path' },
  tail: { short: { n: 'num', c: 'num' }, positional: 'path' },
  wc: { bool: 'lwcm', positional: 'path' },
  grep: {
    bool: 'rnilvwcEFHhoqsxLIZ', // no -R: it follows symlinks out of the project
    short: { e: 'text', m: 'num', A: 'num', B: 'num', C: 'num' },
    long: GREP_LONG,
    positional: 'path', // first one is the pattern; checking it as a path only errs towards asking
  },
  rg: {
    bool: 'nilvwcFHoqsuS', // no -L: it follows symlinks out of the project
    short: { e: 'text', g: 'text', t: 'text', m: 'num', A: 'num', B: 'num', C: 'num' },
    long: { '--hidden': null, '--files': null, '--no-ignore': null, '--glob': 'text', '--type': 'text', '--max-count': 'num', '--color': 'text' },
    positional: 'path',
  },
  find: {
    long: {
      '-name': 'text', '-iname': 'text', '-path': 'text', '-ipath': 'text', '-type': 'text',
      '-maxdepth': 'num', '-mindepth': 'num', '-size': 'text', '-mtime': 'text', '-newer': 'path',
      '-print': null, '-print0': null, '-empty': null, '-not': null, '-a': null, '-and': null, '-o': null, '-or': null,
    },
    positional: 'path',
  },
  du: { bool: 'shc', short: { d: 'num' }, positional: 'path' },
  df: { bool: 'hTiPl', positional: 'text' }, // reports usage of a mount; reads no file content
  free: { bool: 'hmgbwt', positional: 'none' },
  uptime: { bool: 'p', positional: 'none' },
  nproc: { positional: 'none' },
  lscpu: { positional: 'none' },
  whoami: { positional: 'none' },
  id: { positional: 'none' },
  pwd: { positional: 'none' },
  uname: { bool: 'asrnmo', positional: 'none' },
  date: { positional: 'none' },
  which: { positional: 'text' },
  echo: { positional: 'text' },
  stat: { positional: 'path' },
  tree: { bool: 'adf', short: { L: 'num', I: 'text' }, positional: 'path' },
  diff: { bool: 'uqN', long: { '--brief': null }, positional: 'path' }, // no -r: follows symlinks
  ps: {
    bool: 'ef',
    short: { o: 'text' },
    long: { '--sort': 'text' },
    positional: 'text',
    // BSD-style operands: only these; `ps e` / `auxe` would print environments.
    check: (p) => p.every((a) => ['aux', 'ax', 'au'].includes(a)),
  },
  systemctl: {
    bool: 'al',
    long: {
      '--user': null, '--failed': null, '--all': null, '--no-legend': null, '--plain': null,
      '--no-pager': null, '--full': null, '--state': 'text', '--type': 'text',
    },
    positional: 'text',
    // No value-taking short flags are allowed, so the first positional really is the verb.
    check: (p) =>
      p.length === 0 ||
      ['status', 'list-units', 'list-timers', 'list-unit-files', 'is-active', 'is-failed', 'is-enabled', 'show'].includes(p[0]!),
  },
  journalctl: {
    bool: 'qrbkx',
    short: { p: 'text', n: 'num', u: 'text', o: 'text' },
    long: { '--user': null, '--no-pager': null, '--since': 'text', '--until': 'text', '--unit': 'text', '--priority': 'text', '--lines': 'num', '--output': 'text', '--list-boots': null },
    positional: 'none',
  },
  ollama: { positional: 'text', check: (p) => p.length === 1 && ['ps', 'list', 'ls'].includes(p[0]!) },
};

/** git: subcommand first, then its own allowlist. */
const GIT_SPECS: Record<string, Spec> = {
  status: { bool: 'sb', long: { '--short': null, '--porcelain': null, '--branch': null }, positional: 'path' },
  diff: { long: { '--stat': null, '--name-only': null, '--name-status': null, '--cached': null, '--staged': null, '--': null }, positional: 'text' },
  log: { short: { n: 'num' }, long: { '--oneline': null, '--stat': null, '--graph': null, '--name-only': null, '--': null }, positional: 'text' },
  show: { long: { '--stat': null, '--name-only': null, '--': null }, positional: 'text' },
  'ls-files': { positional: 'path' },
  'rev-parse': { long: { '--show-toplevel': null, '--abbrev-ref': null, '--short': null }, positional: 'text' },
};

/** Exact /proc and /sys files that hold system stats — not /proc/<pid>/environ & co. */
const SYSTEM_READ_FILES = [
  /^\/proc\/(meminfo|loadavg|cpuinfo|uptime|stat|swaps|version|mounts|vmstat|diskstats)$/,
  /^\/proc\/pressure\/(cpu|memory|io)$/,
  /^\/sys\/class\/(thermal|power_supply|hwmon)\/[^/]+\/[\w.-]+$/,
];

function within(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Is this path argument safe to read without asking: inside the project
 * (resolved through symlinks), or one of the stats files above?
 */
function pathOk(value: string, root: string): boolean {
  const abs = resolve(root, value);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // doesn't exist: judge the path as written
  }
  return within(real, root) || SYSTEM_READ_FILES.some((re) => re.test(real));
}

function valueOk(type: Value, value: string | undefined, root: string): boolean {
  if (value === undefined) return false;
  if (type === 'num') return /^-?\d+$/.test(value);
  if (type === 'path') return pathOk(value, root);
  return true;
}

/** Walk argv against a spec, getopt-style. Returns the positionals, or null if anything is unknown/unsafe. */
function matchSpec(args: string[], spec: Spec, root: string): string[] | null {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-' ) return null; // stdin: nothing to read, and `cat -` would block
    if (spec.long && (a.startsWith('--') || (a.startsWith('-') && Object.hasOwn(spec.long, a.split('=')[0]!)))) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!Object.hasOwn(spec.long, name)) return null; // also rejects abbreviations
      const type = spec.long[name];
      if (type === null) {
        if (eq !== -1) return null;
        continue;
      }
      const value = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (!valueOk(type!, value, root)) return null;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      // A short cluster: booleans, optionally ending in one value flag whose
      // value is the rest of the cluster or the next arg (getopt semantics).
      for (let j = 1; j < a.length; j++) {
        const ch = a[j]!;
        if (spec.bool?.includes(ch)) continue;
        const type = spec.short && Object.hasOwn(spec.short, ch) ? spec.short[ch] : undefined;
        if (!type) return null;
        const value = j + 1 < a.length ? a.slice(j + 1) : args[++i];
        if (!valueOk(type, value, root)) return null;
        break;
      }
      continue;
    }
    positionals.push(a);
  }
  if (spec.positional === 'none' && positionals.length > 0) return null;
  if (spec.positional === 'path' && !positionals.every((p) => pathOk(p, root))) return null;
  if (spec.check && !spec.check(positionals)) return null;
  return positionals;
}

/**
 * Local repo config can make git run programs during a plain `git diff`
 * (filter drivers, textconv, fsmonitor, external diff …). Global and system
 * config are the user's own; .git/config may come from a cloned repo. So git
 * only runs unasked when every local key is one of these well-known, inert ones.
 */
const SAFE_LOCAL_GIT_KEY =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|remote\.[^=]+\.(url|fetch|pushurl)|branch\.[^=]+\.(remote|merge|rebase)|user\.(name|email)|pull\.rebase|push\.default|fetch\.prune|init\.defaultbranch|extensions\.(objectformat|worktreeconfig)|submodule\.[^=]+\.(url|active))$/i;

function gitConfigIsInert(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['config', '--list', '--show-scope', '--includes'], {
      cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').every((line) => {
      const [scope, kv] = line.split('\t');
      if (!kv || (scope !== 'local' && scope !== 'worktree')) return true;
      return SAFE_LOCAL_GIT_KEY.test(kv.split('=')[0]!);
    });
  } catch {
    return false; // not a repo, old git, … — ask
  }
}

/** True when the command can run without asking: every flag known and safe, every file inside the project. */
export function isAutoApproved(argv: string[], cwd: string = process.cwd()): boolean {
  const [program, ...args] = argv;
  if (!program || program.includes('/')) return false; // ./script or /usr/bin/x: ask
  const root = realpathSync(cwd);
  if (program === 'git') {
    const [sub, ...rest] = args;
    const spec = sub && Object.hasOwn(GIT_SPECS, sub) ? GIT_SPECS[sub] : undefined;
    return !!spec && matchSpec(rest, spec, root) !== null && gitConfigIsInert(root);
  }
  const spec = Object.hasOwn(SPECS, program) ? SPECS[program] : undefined;
  return !!spec && matchSpec(args, spec, root) !== null;
}

export interface CommandResult {
  exitCode: number | null;
  /** stdout + stderr, capped — what the model sees. */
  output: string;
  /** stdout alone, for collectors that parse it. */
  stdout: string;
  timedOut: boolean;
}

const MAX_CAPTURE = 1_000_000; // bytes kept in memory per stream before the cap

/**
 * Kill a child and everything it started. spawn's own `timeout` only kills the
 * direct child, so `npm test` → `tsc` would keep running; the child is started
 * detached (its own process group) and the whole group is signalled.
 */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // group already gone
  }
}

const live = new Set<ChildProcess>();
let exitHooked = false;
/** Detached groups don't die with us: take them down on exit, SIGTERM and SIGHUP. */
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const killAll = (): void => live.forEach(killGroup);
  process.once('exit', killAll);
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      killAll();
      process.exit(sig === 'SIGTERM' ? 143 : 129);
    });
  }
}

export function killTreeAfter(child: ChildProcess, ms: number): { timer: NodeJS.Timeout; fired: () => boolean } {
  hookExit();
  live.add(child);
  // When the command finishes, anything it left running in the background
  // (`cmd &`) is still in its group: kill that too.
  child.once('close', () => {
    killGroup(child);
    live.delete(child);
  });
  child.once('error', () => live.delete(child));
  let didFire = false;
  const timer = setTimeout(() => {
    didFire = true;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, ms);
  return { timer, fired: () => didFire };
}

/** Run argv without a shell, with a timeout, no stdin, and pagers disabled. */
export function runArgv(
  argv: string[],
  { cwd = process.cwd(), timeoutMs = 60_000 }: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  let [program, ...args] = argv;
  if (program === 'git') {
    // A cloned repo's .git/config could point these at arbitrary programs.
    const safe = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '--no-pager'];
    const [sub, ...rest] = args;
    const noExternal = ['diff', 'log', 'show'].includes(sub ?? '') ? ['--no-ext-diff', '--no-textconv'] : [];
    args = [...safe, ...(sub ? [sub] : []), ...noExternal, ...rest];
  }
  if (program === 'systemctl' || program === 'journalctl') args = ['--no-pager', ...args];

  return new Promise((resolvePromise, reject) => {
    const child = spawn(program!, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', SYSTEMD_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    });
    const kill = killTreeAfter(child, timeoutMs);
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { if (out.length < MAX_CAPTURE) out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (err.length < MAX_CAPTURE) err += d.toString('utf8'); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(kill.timer);
      reject(e.code === 'ENOENT' ? new Error(`command not found: ${program}`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(kill.timer);
      const timedOut = kill.fired();
      let output = out;
      if (err.trim()) output += `${out ? '\n' : ''}[stderr]\n${err}`;
      resolvePromise({ exitCode: code, output: capOutput(output), stdout: out, timedOut });
    });
  });
}
