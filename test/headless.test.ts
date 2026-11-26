import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHeadless } from '../src/headless.ts';
import { resetCheckApprovals } from '../src/agent.ts';
import { resetReadState } from '../src/tools.ts';
import { parseFallbackToolCalls, type ChatResult, type Provider } from '../src/provider.ts';

function fake(script: ChatResult[]): Provider {
  return {
    name: 'fake', model: 'fake', contextTokens: 32_768,
    chat: async (_m, _t, onText) => {
      const next = script.shift() ?? { text: 'done', toolCalls: [] };
      if (next.text) onText(next.text);
      return next;
    },
  };
}
const config = { maxSteps: 10, checks: [] as string[], maxFixAttempts: 2 };
const call = (name: string, args: Record<string, unknown>, text = ''): ChatResult => ({ text, toolCalls: [{ name, args }] });

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), 'polvo-headless-')));
  resetReadState();
  resetCheckApprovals();
});

test('--yes approves file writes and checks, reports steps and the final answer', async () => {
  const p = fake([call('write_file', { path: 'a.txt', content: 'hi' }, 'thinking…'), { text: 'Created a.txt.', toolCalls: [] }]);
  const r = await runHeadless(p, { ...config, checks: ['test -f a.txt'] }, 'make a.txt', { yes: true });
  assert.equal(readFileSync('a.txt', 'utf8'), 'hi');
  assert.equal(r.status, 'ok');
  assert.equal(r.steps, 2);
  assert.equal(r.text, 'Created a.txt.');
  assert.deepEqual(r.checks, [{ command: 'test -f a.txt', ok: true }]);
  assert.deepEqual(r.declined, []);
});

test('without --yes it can only read', async () => {
  const p = fake([call('write_file', { path: 'a.txt', content: 'hi' }), { text: 'ok', toolCalls: [] }]);
  const r = await runHeadless(p, config, 'make a.txt', { yes: false });
  assert.equal(existsSync('a.txt'), false);
  assert.deepEqual(r.declined, ['write_file']);
});

test('--yes still declines commands that need approval', async () => {
  const p = fake([call('run_command', { command: 'touch pwned.txt' }), { text: 'ok', toolCalls: [] }]);
  const r = await runHeadless(p, config, 'go', { yes: true });
  assert.equal(existsSync('pwned.txt'), false);
  assert.deepEqual(r.declined, ['run_command']);
});

test('provider errors are reported, not thrown', async () => {
  const p: Provider = { name: 'x', model: 'x', contextTokens: 1000, chat: async () => { throw new Error('boom'); } };
  const r = await runHeadless(p, config, 'go', { yes: true });
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'boom');
});

test('accumulates provider usage and records failed tool details', async () => {
  const p = fake([
    {
      text: '',
      toolCalls: [{ name: 'read_file', args: { path: 'missing.txt' } }],
      usage: { promptTokens: 100, outputTokens: 20, promptEvalMs: 200, evalMs: 500 },
    },
    {
      text: 'done',
      toolCalls: [],
      usage: { promptTokens: 120, outputTokens: 10, promptEvalMs: 50, evalMs: 250 },
    },
  ]);
  const r = await runHeadless(p, config, 'go', { yes: true });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.usage, { promptTokens: 220, outputTokens: 30, promptEvalMs: 250, evalMs: 750 });
  assert.deepEqual(r.promptEvalMsByStep, [200, 50]);
  assert.equal(r.toolCalls[0]?.error, true);
  assert.match(r.toolCalls[0]?.detail ?? '', /missing\.txt/);
});

test('parseFallbackToolCalls recovers Qwen XML-style tool calls from text', () => {
  const raw = 'Let me check.\n\n<function=read_file>\n<parameter=path>\nduration.mjs\n</parameter>\n</function>\n</tool_call>';
  const parsed = parseFallbackToolCalls(raw);
  assert.equal(parsed.text, 'Let me check.');
  assert.deepEqual(parsed.toolCalls, [{ name: 'read_file', args: { path: 'duration.mjs' } }]);
});
