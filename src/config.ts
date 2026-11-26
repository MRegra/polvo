import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRepoMap } from './repomap.js';
import type { ModelOptions } from './provider.js';

export interface Config {
  model: string;
  system: string;
  /** Ollama context window (tokens). The KV cache for it is reserved up front. */
  numCtx: number;
  /** How long Ollama keeps the model loaded after a request ("10m", "0", "-1"). */
  keepAlive: string;
  /** Max model calls per user turn. */
  maxSteps: number;
  /** Shell commands from .polvo.json the harness runs after the model edits files. */
  checks: string[];
  /** How many times failing checks are fed back before the turn stops. */
  maxFixAttempts: number;
  /** Optional Ollama sampling / generation options from .polvo.json. */
  modelOptions?: ModelOptions;
}

export const SYSTEM_PROMPT = `You are polvo, a terminal coding agent working in the user's current project directory.

Tools:
- read_file(path): read a text file (relative to the working directory)
- list_dir(path): list a directory
- grep(pattern, path?, glob?): search for a regex or text across project files
- edit_file(path, old_string, new_string, replace_all?): replace an exact,
  unique snippet in a file — the default way to change an existing file
- write_file(path, content): create a new file, or fully rewrite a small one
- run_command(command): run ONE program without a shell (no pipes, redirects
  or &&). Read-only commands run directly; anything else asks the user.
- system_snapshot(): memory, disk, load, failed services, recent errors and
  top processes on this machine, with threshold alerts

Rules:
- Read a file before you edit it. old_string must match the file exactly,
  including indentation, and be unique — include surrounding lines if needed.
- Make small, focused changes. After you edit files the harness may run the
  project's checks and send you any failures; fix them before finishing.
- For a new project or a multi-file change, start with a short numbered plan.
- If a tool call fails, read the error and change your approach instead of
  repeating the same call.
- Be concise; this is a terminal, so keep Markdown light.`;

export const DEFAULTS = {
  model: 'qwen3-coder:30b',
  numCtx: 32_768,
  keepAlive: '10m',
  maxSteps: 25,
  maxFixAttempts: 3,
} as const;

interface ProjectFile {
  model?: unknown;
  numCtx?: unknown;
  keepAlive?: unknown;
  maxSteps?: unknown;
  checks?: unknown;
  maxFixAttempts?: unknown;
  options?: unknown;
}

/** Read .polvo.json from the project root; a missing file is fine, a broken one is an error. */
export function readProjectFile(dir: string = process.cwd()): ProjectFile {
  let raw: string;
  try {
    raw = readFileSync(join(dir, '.polvo.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('.polvo.json must contain a JSON object');
  }
  return parsed as ProjectFile;
}

function positiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got ${String(value)})`);
  }
  return n;
}

function keepAliveValue(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  const s = String(value).trim();
  // Ollama accepts a Go duration ("10m", "1h30m") or a number of seconds (0 unloads, -1 = forever).
  if (!/^(-1|\d+|(\d+(\.\d+)?(ms|s|m|h))+)$/.test(s)) {
    throw new Error(`keepAlive must look like "10m", "0" or "-1" (got ${s})`);
  }
  return s;
}

function parseModelOptions(raw: unknown): ModelOptions | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('.polvo.json "options" must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const out: ModelOptions = {};
  const floatKeys = ['temperature', 'top_p', 'repeat_penalty'] as const;
  for (const key of floatKeys) {
    if (obj[key] !== undefined) {
      if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key])) {
        throw new Error(`options.${key} must be a finite number`);
      }
      out[key] = obj[key] as number;
    }
  }
  const intKeys = ['top_k', 'num_predict'] as const;
  for (const key of intKeys) {
    if (obj[key] !== undefined) {
      const n = obj[key];
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
        throw new Error(`options.${key} must be a positive integer`);
      }
      out[key] = n;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function buildSystemPrompt(cwd: string = process.cwd()): string {
  const map = buildRepoMap(cwd);
  return map ? `${SYSTEM_PROMPT}\n\nProject files:\n${map}` : SYSTEM_PROMPT;
}

/**
 * Resolve runtime config. Precedence: CLI flag > env > .polvo.json > default.
 * `checks` only comes from .polvo.json, and the user approves them once per
 * session before they run (see agent.ts), since a cloned repo could ship one.
 */
export function loadConfig(
  cliModel?: string,
  env: NodeJS.ProcessEnv = process.env,
  project: ProjectFile = readProjectFile(),
): Config {
  const model =
    cliModel ??
    (env.POLVO_MODEL || undefined) ??
    (typeof project.model === 'string' ? project.model : undefined) ??
    DEFAULTS.model;

  const checks = project.checks ?? [];
  if (
    !Array.isArray(checks) ||
    !checks.every((c) => typeof c === 'string' && c.trim() !== '')
  ) {
    throw new Error('.polvo.json "checks" must be an array of command strings');
  }
  const modelOptions = parseModelOptions(project.options);

  return {
    model,
    system: buildSystemPrompt(),
    numCtx:
      positiveInt(env.POLVO_NUM_CTX, 'POLVO_NUM_CTX') ??
      positiveInt(project.numCtx, 'numCtx') ??
      DEFAULTS.numCtx,
    keepAlive:
      keepAliveValue(env.POLVO_KEEP_ALIVE) ??
      keepAliveValue(project.keepAlive) ??
      DEFAULTS.keepAlive,
    maxSteps:
      positiveInt(env.POLVO_MAX_STEPS, 'POLVO_MAX_STEPS') ??
      positiveInt(project.maxSteps, 'maxSteps') ??
      DEFAULTS.maxSteps,
    checks,
    maxFixAttempts:
      positiveInt(project.maxFixAttempts, 'maxFixAttempts') ??
      DEFAULTS.maxFixAttempts,
    ...(modelOptions ? { modelOptions } : {}),
  };
}
