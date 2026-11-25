#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';

import { loadConfig, type Config } from './config.js';
import { OllamaProvider, checkOllama } from './provider.js';
import { App } from './app.js';
import { collectSnapshot, evaluate, formatReport } from './monitor.js';

const USAGE = `polvo — a terminal coding agent (v0.4.0)

usage: polvo [options]
       polvo monitor [--json]   check this machine (no model needed);
                                exits 1 on a warning, 2 on a critical alert

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
  /plan <task>       read-only: the model explores and proposes a plan
  /exit, /quit       leave   ·   Ctrl-C also quits`;

function parse(): {
  values: { model?: string; help?: boolean; version?: boolean; json?: boolean };
  positionals: string[];
} {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
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

const { values, positionals } = parse();

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (values.version) {
  console.log('polvo 0.4.0');
  process.exit(0);
}

if (positionals[0] === 'monitor') {
  const snapshot = await collectSnapshot();
  const alerts = evaluate(snapshot);
  console.log(values.json ? JSON.stringify({ alerts, ...snapshot }, null, 2) : formatReport(snapshot, alerts));
  process.exit(alerts.some((a) => a.level === 'critical') ? 2 : alerts.length ? 1 : 0);
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
