#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import { loadConfig } from './config.js';
import { OllamaProvider, checkOllama } from './provider.js';
import { App } from './app.js';

const USAGE = `polvo — a terminal coding agent (v0.3.15)

usage: polvo [options]

options:
  -m, --model <id>   Ollama model to use (default: $POLVO_MODEL or qwen3-coder:30b)
  -h, --help         show this help
  -v, --version      show version

env:
  POLVO_MODEL        default model id
  OLLAMA_HOST        Ollama server (default: http://127.0.0.1:11434)

while running:
  /exit, /quit       leave   ·   Ctrl-C also quits`;

function parse(): { model?: string; help?: boolean; version?: boolean } {
  try {
    return parseArgs({
      options: {
        model: { type: 'string', short: 'm' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }).values;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg + '\n\n' + USAGE);
    process.exit(2);
  }
}

const values = parse();
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.version) {
  console.log('polvo 0.3.15');
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error(
    'polvo needs an interactive terminal (a TTY) — run it directly, not piped.',
  );
  process.exit(1);
}

const config = loadConfig(values.model);
const warning = await checkOllama(config.model);
const provider = new OllamaProvider(config.model, config.system);
const app = render(createElement(App, { provider, warning }));

try {
  await app.waitUntilExit();
} finally {
  // The Ollama daemon is separate from Polvo. Explicitly unload only the
  // model this Polvo instance used; do not terminate the shared daemon.
  try {
    await provider.unload();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nCould not unload Ollama model: ${message}`);
  }
}

process.exitCode = 0;