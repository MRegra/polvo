#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { AnthropicProvider } from './provider.js';
import { runRepl } from './repl.js';
import * as ui from './ui.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string', short: 'm' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

if (values.help) {
  console.log(`polvo — a terminal coding agent (v0.0.1)

usage: polvo [options]

options:
  -m, --model <id>   model to use (default: $POLVO_MODEL or claude-opus-5-5)
  -h, --help         show this help
  -v, --version      show version

env:
  ANTHROPIC_API_KEY  required to talk to the model
  POLVO_MODEL        default model id
  NO_COLOR           disable colored output

while running:
  /exit, /quit       leave`);
  process.exit(0);
}

if (values.version) {
  console.log('polvo 0.0.1');
  process.exit(0);
}

const config = loadConfig(values.model);

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  process.stdout.write(
    ui.errorLine('no ANTHROPIC_API_KEY set — export one before chatting') + '\n\n',
  );
}

const provider = new AnthropicProvider(config.model, config.system);
await runRepl(provider);
