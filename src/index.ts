#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';

import { loadConfig, type Config } from './config.js';
import { OllamaProvider, checkOllama } from './provider.js';
import { App } from './app.js';
import { collectSnapshot, evaluate, formatReport } from './monitor.js';
import { update } from './update.js';
import { runHeadless } from './headless.js';
import { REPO_DIR, VERSION } from './version.js';

const USAGE = `polvo — a terminal coding agent (v${VERSION})

usage: polvo [options]
       polvo monitor [--json]   check this machine (no model needed);
                                exits 1 on a warning, 2 on a critical alert
       polvo update [--check]   pull the latest master and rebuild
       polvo eval [options]     run the benchmark suite (alias: benchmark)
                                --quick (3 key tasks), --test (run npm test first)
       polvo run [--yes] [--json] "<task>"
                                one turn without the TUI. Without --yes it can
                                only read; --yes approves file edits and checks
                                (never commands that would need approval)

options:
  -m, --model <id>   Ollama model to use (default: $POLVO_MODEL or qwen3-coder:30b)
  -h, --help         show this help
  -v, --version      show version

env:
  POLVO_MODEL        default model id
  POLVO_NUM_CTX      context window in tokens (default 32768; ~94 MB RAM per 1k)
  POLVO_KEEP_ALIVE   keep the model loaded this long when idle (default 10m)
  POLVO_MAX_STEPS    max model calls per turn (default 25)
  OLLAMA_HOST        Ollama server (default: http://127.0.0.1:11434)

project file (.polvo.json, all optional):
  { "model": "...", "numCtx": 32768, "keepAlive": "10m", "maxSteps": 25,
    "checks": ["npm run typecheck", "npm test"], "maxFixAttempts": 3 }
  checks run after the model changes files; you approve them once per session.

while running:
  /manual, /help     show built-in manual
  /plan <task>       read-only: the model explores and proposes a plan
  /undo              revert all file changes from the last turn
  /compact           compact context window on demand
  /status, /clear    show session status / clear history
  /exit, /quit       leave   ·   Ctrl-C also quits`;

function parse(): {
  values: { model?: string; help?: boolean; version?: boolean; json?: boolean; check?: boolean; yes?: boolean };
  positionals: string[];
} {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        check: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        model: { type: 'string', short: 'm' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
      },
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);

    console.error(msg + '\n\n' + USAGE);
    process.exit(2);
  }
}

const EVAL_USAGE = `usage: polvo eval [options]   (alias: polvo benchmark)

options:
  --quick              run only the 3 key tasks (answer-question, implement-to-tests, rename-function)
  --test               run npm run typecheck && npm test before the eval
  --tasks <a,b>        comma-separated task names
  --model <id>         Ollama model (default: $POLVO_MODEL or qwen3-coder:30b)
  --num-ctx <n>        context window (default: 16384)
  --kv-cache <type>    f16 | q8_0 | q4_0 (default: $POLVO_KV_CACHE or f16)
  --min-free-gb <n>    abort if available RAM drops below this (default: 3)
  --headroom-gb <n>    required free RAM headroom before loading (default: 4)
  --timeout-min <n>    per-task timeout in minutes (default: 20)`;

if (process.argv[2] === 'eval' || process.argv[2] === 'benchmark') {
  const rest = process.argv.slice(3);
  if (rest.includes('-h') || rest.includes('--help')) {
    console.log(EVAL_USAGE);
    process.exit(0);
  }
  const runTestsFirst = rest.includes('--test');
  const forwarded = rest.filter((a) => a !== '--test');
  if (runTestsFirst) {
    const tc = spawnSync('npm', ['run', 'typecheck'], { cwd: REPO_DIR, stdio: 'inherit' });
    if (tc.status !== 0) process.exit(tc.status ?? 1);
    const t = spawnSync('npm', ['test'], { cwd: REPO_DIR, stdio: 'inherit' });
    if (t.status !== 0) process.exit(t.status ?? 1);
  }
  const ev = spawnSync('npm', ['run', '--silent', 'eval', '--', ...forwarded], {
    cwd: REPO_DIR,
    stdio: 'inherit',
  });
  process.exit(ev.status ?? 1);
}

const { values, positionals } = parse();

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (values.version) {
  console.log(`polvo ${VERSION}`);
  process.exit(0);
}

if (positionals[0] === 'update') {
  try {
    const r = update(REPO_DIR, { check: values.check, log: (l) => console.log(l) });
    if (r.status === 'up-to-date') console.log(`polvo ${r.version} is up to date`);
    else if (r.status === 'available') console.log(`${r.behind} new commit(s) on master — run: polvo update`);
    else console.log(`polvo ${r.from} → ${r.to} (${r.commits} commit${r.commits === 1 ? '' : 's'})`);
    process.exit(0);
  } catch (err) {
    console.error(`polvo update: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
if (positionals[0] === 'monitor') {
  const snapshot = await collectSnapshot();
  const alerts = evaluate(snapshot);
  console.log(values.json ? JSON.stringify({ alerts, ...snapshot }, null, 2) : formatReport(snapshot, alerts));
  process.exit(alerts.some((a) => a.level === 'critical') ? 2 : alerts.length ? 1 : 0);
}
if (positionals[0] === 'run') {
  const prompt = positionals.slice(1).join(' ').trim();
  if (!prompt) {
    console.error('usage: polvo run [--yes] [--json] "<task>"');
    process.exit(2);
  }
  let runConfig: Config;
  try {
    runConfig = loadConfig(values.model);
  } catch (err) {
    console.error(`polvo: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const problem = await checkOllama(runConfig.model);
  if (problem) {
    console.error(`polvo: ${problem}`);
    process.exit(2);
  }
  const headlessNotes = values.yes
    ? [
        'Running non-interactively with --yes: file edits/writes are approved, but do NOT call run_command to run node, npm, or tests — non-read-only commands are blocked in headless mode and will be declined.',
        ...(runConfig.checks.length
          ? [`Project checks (${runConfig.checks.join(', ')}) run automatically after you finish editing files — do not call run_command to run them yourself.`]
          : []),
      ]
    : ['Running non-interactively (read-only): file edits and non-read-only commands will be declined.'];
  const runProvider = new OllamaProvider(runConfig.model, `${runConfig.system}\n\n${headlessNotes.join('\n')}`, {
    numCtx: runConfig.numCtx,
    keepAlive: runConfig.keepAlive,
    modelOptions: runConfig.modelOptions,
  });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const result = await runHeadless(runProvider, runConfig, prompt, {
    yes: values.yes === true,
    signal: controller.signal,
    onText: values.json ? undefined : (d) => process.stdout.write(d),
  });
  if (values.json) {
    console.log(JSON.stringify({ model: runConfig.model, ...result }));
  } else {
    process.stdout.write('\n');
    for (const n of result.notices) console.error(`· ${n}`);
    if (result.error) console.error(`⚠ ${result.error}`);
  }
  const checksFailed = result.checks.length > 0 && !result.checks.slice(-runConfig.checks.length).every((c) => c.ok);
  process.exit(result.status === 'error' || checksFailed ? 1 : 0);
}
if (positionals.length > 0) {
  console.error(`unknown command: ${positionals[0]}\n\n${USAGE}`);
  process.exit(2);
}

if (!process.stdin.isTTY) {
  console.error(
    'polvo needs an interactive terminal (a TTY) — run it directly, not piped.',
  );
  process.exit(1);
}

let config: Config;
try {
  config = loadConfig(values.model);
} catch (err) {
  console.error(`polvo: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
const warning = await checkOllama(config.model);
const provider = new OllamaProvider(config.model, config.system, {
  numCtx: config.numCtx,
  keepAlive: config.keepAlive,
  modelOptions: config.modelOptions,
});

const app = render(
  createElement(App, { provider, warning, config }),
);

try {
  await app.waitUntilExit();
} finally {
  // Unload only the model used by this Polvo instance.
  // Never terminate the shared Ollama daemon.
  try {
    await provider.unload();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);

    console.error(
      `\nCould not unload Ollama model: ${message}`,
    );
  }
}

process.exitCode = 0;
