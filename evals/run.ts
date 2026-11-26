/**
 * Eval suite: run polvo headless on small real tasks and score it with hidden
 * checks, so a harness/prompt/model change can be judged by numbers.
 *
 *   npm run eval -- [--model qwen3-coder:30b] [--tasks fix-json,add-flag] [--quick]
 *                   [--num-ctx 16384] [--timeout-min 20] [--min-free-gb 3]
 *                   [--headroom-gb 4] [--kv-cache f16|q8_0|q4_0]
 *
 * RAM safety (other programs must keep running): before loading a model it
 * checks the model fits in MemAvailable with headroom, and a watchdog aborts
 * the run and unloads the model if free memory falls below --min-free-gb.
 */
import { execFile, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseMeminfo } from '../src/monitor.ts';

const ROOT = resolve(import.meta.dirname, '..');
const TASKS_DIR = join(ROOT, 'evals', 'tasks');
const RESULTS_DIR = join(ROOT, 'evals', 'results');
const OLLAMA = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, '');

export interface CheckOutcome {
  pass: boolean;
  reason?: string;
}

/** Run a task's hidden check against a work dir. The model's answer is in <workDir>/.output. */
export function runCheck(taskDir: string, workDir: string): Promise<CheckOutcome> {
  return new Promise((done) => {
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    execFile(
      process.execPath,
      [join(taskDir, 'check.mjs'), workDir, join(workDir, '.output')],
      { timeout: 60_000, encoding: 'utf8', env },
      (err, _stdout, stderr) => {
        if (!err) return done({ pass: true });
        // Node prints the source line and a caret first; the "XxxError: message" line is the useful one.
        const lines = stderr.split('\n').map((l) => l.trim());
        const at = lines.findIndex((l) => /^(\w*Error)(\s\[\w+\])?:/.test(l));
        const msg = at === -1 ? lines.filter(Boolean).pop() : lines.slice(at, at + 10).filter(Boolean).join(' ');
        done({ pass: false, reason: (msg ?? String(err)).slice(0, 600) });
      },
    );
  });
}

function memAvailableGB(): number {
  return (parseMeminfo(readFileSync('/proc/meminfo', 'utf8'))?.availableMB ?? 0) / 1024;
}

async function ollamaJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OLLAMA}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function loadedModels(): Promise<string[]> {
  const r = await ollamaJSON<{ models?: Array<{ name: string }> }>('/api/ps');
  return (r.models ?? []).map((m) => m.name);
}

async function unload(model: string): Promise<void> {
  await ollamaJSON('/api/generate', { model, prompt: '', keep_alive: 0, stream: false }).catch(() => undefined);
}

/** Rough RAM the model needs once loaded: weights + KV cache + buffers. */
const KV_GB_PER_1K: Record<string, number> = { f16: 0.1, q8_0: 0.05, q4_0: 0.025 };

async function estimateNeedGB(model: string, numCtx: number, kvCache: string): Promise<number> {
  const perK = KV_GB_PER_1K[kvCache];
  if (perK === undefined) throw new Error(`--kv-cache must be one of ${Object.keys(KV_GB_PER_1K).join(', ')}`);
  const tags = await ollamaJSON<{ models?: Array<{ name: string; size: number }> }>('/api/tags');
  const entry = tags.models?.find((m) => m.name === model || m.name === `${model}:latest`);
  if (!entry) throw new Error(`model ${model} is not pulled (ollama pull ${model})`);
  // f16: ~0.1 GB per 1k tokens of context covers qwen3-coder:30b (~0.094) and smaller models.
  return entry.size / 1e9 + (numCtx / 1000) * perK + 1.5;
}

interface TaskResult {
  task: string;
  pass: boolean;
  reason?: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  errors?: Array<{ tool: string; message: string }>;
  checksRun: number;
  declined: string[];
  promptTokens?: number;
  outputTokens?: number;
  evalTokPerS?: number;
  promptEvalS?: number;
  firstPromptEvalS?: number;
  cachedPromptEvalS?: number;
  durationS: number;
  error?: string;
}

interface Headless {
  status: string;
  error?: string;
  text: string;
  steps: number;
  toolCalls: Array<{ name: string; error: boolean; detail?: string }>;
  checks: unknown[];
  declined: string[];
  usage?: {
    promptTokens: number;
    outputTokens: number;
    promptEvalMs: number;
    evalMs: number;
  };
  promptEvalMsByStep?: number[];
}

class LowMemory extends Error {}

function runPolvo(
  workDir: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  minFreeGB: number,
): Promise<Headless> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(ROOT, 'dist', 'index.js'), 'run', '--yes', '--json', prompt], {
      cwd: workDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let reason: Error | null = null;
    const killGroup = (why: Error): void => {
      reason ??= why;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    };
    const timer = setTimeout(() => killGroup(new Error(`timed out after ${timeoutMs / 60_000} min`)), timeoutMs);
    const watchdog = setInterval(() => {
      const free = memAvailableGB();
      if (free < minFreeGB) killGroup(new LowMemory(`only ${free.toFixed(1)} GB RAM available (< ${minFreeGB})`));
    }, 2000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('close', () => {
      clearTimeout(timer);
      clearInterval(watchdog);
      if (reason) return fail(reason);
      const line = out.trim().split('\n').pop() ?? '';
      try {
        done(JSON.parse(line) as Headless);
      } catch {
        fail(new Error(`no JSON result (stderr: ${err.trim().slice(0, 200)})`));
      }
    });
  });
}

const QUICK_TASKS = ['answer-question', 'implement-to-tests', 'rename-function'];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: process.env.POLVO_MODEL ?? 'qwen3-coder:30b' },
      tasks: { type: 'string' },
      quick: { type: 'boolean', default: false },
      'num-ctx': { type: 'string', default: '16384' },
      'timeout-min': { type: 'string', default: '20' },
      'min-free-gb': { type: 'string', default: '3' },
      'headroom-gb': { type: 'string', default: '4' },
      // Match the server's OLLAMA_KV_CACHE_TYPE: q8_0 halves the context memory, q4_0 quarters it.
      'kv-cache': { type: 'string', default: process.env.POLVO_KV_CACHE ?? 'f16' },
    },
  });
  const model = values.model!;
  const numCtx = Number(values['num-ctx']);
  const minFree = Number(values['min-free-gb']);
  const headroom = Number(values['headroom-gb']);
  const all = readdirSync(TASKS_DIR).sort();
  const wanted = values.tasks
    ? values.tasks.split(',')
    : values.quick
      ? QUICK_TASKS
      : all;
  const unknown = wanted.filter((t) => !all.includes(t));
  if (unknown.length) throw new Error(`unknown task(s): ${unknown.join(', ')}`);

  const alreadyLoaded = (await loadedModels()).some((m) => m === model || m === `${model}:latest`);
  if (!alreadyLoaded) {
    const need = await estimateNeedGB(model, numCtx, values['kv-cache']!);
    const free = memAvailableGB();
    if (need + headroom > free) {
      throw new Error(
        `${model} needs ~${need.toFixed(1)} GB; only ${free.toFixed(1)} GB available and ${headroom} GB must stay free. ` +
          'Free some memory, use a smaller model or --num-ctx, or lower --headroom-gb.',
      );
    }
    console.log(`RAM ok: ${model} needs ~${need.toFixed(1)} GB, ${free.toFixed(1)} GB available`);
  }

  console.log('building polvo …');
  await new Promise<void>((ok, bad) =>
    execFile('npm', ['run', '-s', 'build'], { cwd: ROOT }, (e) => (e ? bad(e) : ok())),
  );

  const env = {
    ...process.env,
    POLVO_MODEL: model,
    POLVO_NUM_CTX: String(numCtx),
    POLVO_KEEP_ALIVE: '10m', // stay loaded between tasks; unloaded at the end
  };
  const results: TaskResult[] = [];
  try {
    for (const task of wanted) {
      const taskDir = join(TASKS_DIR, task);
      const { prompt } = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8')) as { prompt: string };
      const workDir = mkdtempSync(join(tmpdir(), `polvo-eval-${task}-`));
      cpSync(join(taskDir, 'repo'), workDir, { recursive: true });
      process.stdout.write(`▸ ${task.padEnd(22)}`);
      const started = Date.now();
      let r: TaskResult;
      try {
        const h = await runPolvo(workDir, prompt, env, Number(values['timeout-min']) * 60_000, minFree);
        writeFileSync(join(workDir, '.output'), h.text);
        const check = await runCheck(taskDir, workDir);
        const errors = h.toolCalls
          .filter((c) => c.error)
          .map((c) => ({ tool: c.name, message: c.detail ?? '' }));
        const evalTokPerS =
          h.usage && h.usage.evalMs > 0
            ? Number(((h.usage.outputTokens / h.usage.evalMs) * 1000).toFixed(1))
            : undefined;
        const promptEvalS =
          h.usage && h.usage.promptEvalMs > 0
            ? Number((h.usage.promptEvalMs / 1000).toFixed(1))
            : undefined;
        const byStep = h.promptEvalMsByStep ?? [];
        const firstPromptEvalS =
          byStep.length > 0 ? Number((byStep[0]! / 1000).toFixed(1)) : undefined;
        const cachedSteps = byStep.slice(1);
        const cachedPromptEvalS =
          cachedSteps.length > 0
            ? Number((cachedSteps.reduce((a, b) => a + b, 0) / cachedSteps.length / 1000).toFixed(1))
            : undefined;
        r = {
          task, pass: check.pass && h.status === 'ok', reason: check.reason, error: h.error,
          steps: h.steps, toolCalls: h.toolCalls.length, toolErrors: errors.length,
          ...(errors.length ? { errors } : {}),
          checksRun: h.checks.length, declined: h.declined,
          ...(h.usage ? { promptTokens: h.usage.promptTokens, outputTokens: h.usage.outputTokens } : {}),
          ...(evalTokPerS !== undefined ? { evalTokPerS } : {}),
          ...(promptEvalS !== undefined ? { promptEvalS } : {}),
          ...(firstPromptEvalS !== undefined ? { firstPromptEvalS } : {}),
          ...(cachedPromptEvalS !== undefined ? { cachedPromptEvalS } : {}),
          durationS: Math.round((Date.now() - started) / 1000),
        };
      } catch (err) {
        r = {
          task, pass: false, error: err instanceof Error ? err.message : String(err),
          steps: 0, toolCalls: 0, toolErrors: 0, checksRun: 0, declined: [],
          durationS: Math.round((Date.now() - started) / 1000),
        };
        if (err instanceof LowMemory) {
          results.push(r);
          console.log(`✗ aborted: ${r.error}`);
          break;
        }
      }
      results.push(r);
      console.log(`${r.pass ? '✓' : '✗'} ${String(r.durationS).padStart(4)}s  steps ${r.steps}  tools ${r.toolCalls} (${r.toolErrors} err)` +
        (r.evalTokPerS !== undefined ? `  ${r.evalTokPerS} tok/s` : '') +
        (r.pass ? '' : `  — ${(r.error ?? r.reason ?? '').slice(0, 120)}`) + `  [${workDir}]`);
    }
  } finally {
    if (!alreadyLoaded) await unload(model);
  }

  const passed = results.filter((r) => r.pass).length;
  const summary = {
    model, numCtx, date: new Date().toISOString(),
    passed, total: results.length,
    totalSteps: results.reduce((s, r) => s + r.steps, 0),
    totalSeconds: results.reduce((s, r) => s + r.durationS, 0),
    results,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${summary.date.slice(0, 16).replace(/[:T]/g, '-')}-${model.replace(/[^\w.-]/g, '_')}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n${passed}/${results.length} passed · ${summary.totalSteps} steps · ${summary.totalSeconds}s · ${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(`eval: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
