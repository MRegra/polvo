#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { OllamaProvider, checkOllama } from './provider.js';
import { runRepl } from './repl.js';
import * as ui from './ui.js';

const USAGE = `polvo — a terminal coding agent (v0.0.1)

usage: polvo [options]

options:
  -m, --model <id>   Ollama model to use (default: $POLVO_MODEL or qwen3-coder:30b)
  -h, --help         show this help
  -v, --version      show version

env:
  POLVO_MODEL        default model id
  OLLAMA_HOST        Ollama server (default: http://127.0.0.1:11434)
  NO_COLOR           disable colored output

while running:
  /exit, /quit       leave`;

// A bad flag (unknown option, stray positional, bare -m) throws from parseArgs;
// turn that into a clean usage message instead of a raw Node stack trace.
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
    process.stderr.write(ui.errorLine(msg) + '\n\n' + USAGE + '\n');
    process.exit(2);
  }
}

const values = parse();

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.version) {
  console.log('polvo 0.0.1');
  process.exit(0);
}

const config = loadConfig(values.model);

// Diagnostics go to stderr so stdout stays clean (pipeable, no interleave).
const warning = await checkOllama(config.model);
if (warning) {
  process.stderr.write(ui.errorLine(warning) + '\n\n');
}

const provider = new OllamaProvider(config.model, config.system);
await runRepl(provider);
