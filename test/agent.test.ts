import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, resetCheckApprovals, type AgentEvents } from '../src/agent.ts';
import { resetReadState } from '../src/tools.ts';
import type { ChatResult, Message, Provider, ToolSchema } from '../src/provider.ts';

/** Replays scripted replies and records what the model was shown. */
class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly model = 'fake';
  readonly contextTokens = 32_768;
  seen: Array<{ messages: Message[]; tools: string[] }> = [];
  constructor(private script: Array<ChatResult | ((m: Message[]) => ChatResult)>) {}
  async chat(messages: Message[], tools: ToolSchema[]): Promise<ChatResult> {
    this.seen.push({ messages: structuredClone(messages), tools: tools.map((t) => t.name) });
    const next = this.script.shift() ?? { text: 'done', toolCalls: [] };
    return typeof next === 'function' ? next(messages) : next;
  }
}

function recorder(approve: (tool: string) => boolean = () => true) {
  const log: string[] = [];
  const events: AgentEvents = {
    onText: () => {},
    onToolCall: (n) => log.push(`call ${n}`),
    onToolResult: (n, r, e) => log.push(`${e ? 'error' : 'result'} ${n}: ${r.slice(0, 80)}`),
    confirm: async (r) => (log.push(`confirm ${r.tool}`), approve(r.tool)),
    onCheck: (r) => log.push(`check ${r.ok ? 'ok' : 'fail'} ${r.command}`),
    onNotice: (t) => log.push(`notice ${t}`),
  };
  return { log, events };
}

const call = (name: string, args: Record<string, unknown>): ChatResult => ({ text: '', toolCalls: [{ name, args }] });
const opts = { maxSteps: 25, contextTokens: 32_768 };

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), 'polvo-agent-')));
  resetReadState();
  resetCheckApprovals();
});

test('refuses then stops a repeated identical tool call', async () => {
  const p = new FakeProvider(Array.from({ length: 10 }, () => call('list_dir', { path: '.' })));
  const { log, events } = recorder();
  await runAgent(p, [{ role: 'user', content: 'go' }], events, undefined, opts);
  assert.ok(log.some((l) => l.startsWith('error list_dir: you already made this exact')));
  assert.ok(log.at(-1)!.includes('kept repeating'));
  assert.equal(p.seen.length, 5);
});

test('stops at the step limit', async () => {
  const p = new FakeProvider(Array.from({ length: 10 }, (_, i) => call('list_dir', { path: `d${i}` })));
  const { log, events } = recorder();
  await runAgent(p, [{ role: 'user', content: 'go' }], events, undefined, { ...opts, maxSteps: 3 });
  assert.equal(p.seen.length, 3);
  assert.match(log.at(-1)!, /limit of 3 steps/);
});

test('plan mode hides and refuses state-changing tools', async () => {
  const p = new FakeProvider([call('write_file', { path: 'x.txt', content: 'x' })]);
  const { log, events } = recorder();
  await runAgent(p, [{ role: 'user', content: 'plan' }], events, undefined, { ...opts, readOnly: true });
  assert.ok(!p.seen[0]!.tools.includes('write_file') && !p.seen[0]!.tools.includes('edit_file'));
  assert.ok(p.seen[0]!.tools.includes('read_file'));
  assert.ok(log.some((l) => l.startsWith('error write_file: plan mode')));
  assert.ok(!log.some((l) => l.startsWith('confirm')));
});

test('failing checks go back to the model until they pass', async () => {
  const p = new FakeProvider([
    call('write_file', { path: 'answer.txt', content: 'wrong' }),
    { text: 'done', toolCalls: [] },
    (m) => {
      assert.match(m.at(-1)!.content, /checks failed[\s\S]*expected 42/);
      return call('read_file', { path: 'answer.txt' });
    },
    call('edit_file', { path: 'answer.txt', old_string: 'wrong', new_string: '42' }),
    { text: 'fixed', toolCalls: [] },
  ]);
  const { log, events } = recorder();
  const checks = ['grep -qx 42 answer.txt || { echo "expected 42"; exit 1; }'];
  await runAgent(p, [{ role: 'user', content: 'go' }], events, undefined, { ...opts, checks });
  assert.equal(readFileSync('answer.txt', 'utf8'), '42');
  assert.deepEqual(log.filter((l) => l.startsWith('check')), [`check fail ${checks[0]}`, `check ok ${checks[0]}`]);
  assert.equal(log.filter((l) => l === 'confirm run_checks').length, 1, 'checks approved once');
});

test('gives up after maxFixAttempts and skips checks the user declines', async () => {
  const p = new FakeProvider([
    call('write_file', { path: 'a.txt', content: '1' }), { text: 'done', toolCalls: [] },
    call('write_file', { path: 'b.txt', content: '1' }), { text: 'done', toolCalls: [] },
  ]);
  const { log, events } = recorder();
  await runAgent(p, [{ role: 'user', content: 'go' }], events, undefined, { ...opts, checks: ['false'], maxFixAttempts: 1 });
  assert.match(log.at(-1)!, /still failing after 1 fix attempt/);

  resetCheckApprovals();
  const p2 = new FakeProvider([call('write_file', { path: 'c.txt', content: '1' }), { text: 'done', toolCalls: [] }]);
  const r2 = recorder((tool) => tool !== 'run_checks');
  await runAgent(p2, [{ role: 'user', content: 'go' }], r2.events, undefined, { ...opts, checks: ['false'] });
  assert.ok(r2.log.includes('notice checks skipped — not approved'));
});

test('no checks run when nothing changed', async () => {
  const p = new FakeProvider([call('list_dir', {}), { text: 'here', toolCalls: [] }]);
  const { log, events } = recorder();
  await runAgent(p, [{ role: 'user', content: 'go' }], events, undefined, { ...opts, checks: ['false'] });
  assert.ok(!log.some((l) => l.startsWith('check') || l === 'confirm run_checks'));
});
