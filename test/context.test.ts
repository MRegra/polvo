import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capOutput, estimateMessages, fitContext } from '../src/context.ts';
import type { Message } from '../src/provider.ts';

test('capOutput keeps head and tail', () => {
  const s = 'H'.repeat(1000) + 'M'.repeat(5000) + 'T'.repeat(1000);
  const c = capOutput(s, 2000);
  assert.ok(c.startsWith('H') && c.endsWith('T') && c.includes('chars omitted'));
  assert.ok(c.length < 2100);
  assert.equal(capOutput('short', 2000), 'short');
});

function turn(i: number, size: number): Message[] {
  return [
    { role: 'user', content: `q${i}` },
    { role: 'assistant', content: '', tool_calls: [{ name: 'read_file', args: { path: `f${i}` } }] },
    { role: 'tool', content: 'x'.repeat(size), tool_name: 'read_file' },
    { role: 'assistant', content: `a${i}` },
  ];
}

test('fitContext elides old tool outputs first, keeping recent ones', () => {
  const h = Array.from({ length: 6 }, (_, i) => turn(i, 3000)).flat();
  const before = h.length;
  const r = fitContext(h, 4500, 2);
  assert.ok(r.elided > 0);
  assert.equal(r.dropped, 0);
  assert.equal(h.length, before);
  assert.equal(h[h.length - 2]!.content.length, 3000, 'latest tool output intact');
  assert.ok(estimateMessages(h) <= 4500);
});

test('fitContext drops whole turns at user boundaries and keeps the current turn', () => {
  const h = [...turn(0, 9000), ...turn(1, 9000), ...turn(2, 9000)];
  fitContext(h, 4000, 4);
  assert.equal(h[0]!.role, 'user');
  for (let i = 0; i < h.length; i++) {
    if (h[i]!.role === 'tool') assert.ok(h[i - 1]!.tool_calls, 'every tool result keeps its call');
  }
  assert.equal(h[0]!.content, 'q2');
});

test('a harness-injected report never displaces the real task', () => {
  const h: Message[] = [
    { role: 'user', content: 'the real task ' + 'x'.repeat(600) },
    { role: 'assistant', content: '', tool_calls: [{ name: 'read_file', args: {} }] },
    { role: 'tool', content: 'y'.repeat(3000), tool_name: 'read_file' },
    { role: 'user', content: '[polvo] checks failed', synthetic: true },
    { role: 'assistant', content: 'ok' },
  ];
  fitContext(h, 900, 0);
  assert.ok(h[0]!.content.startsWith('the real task'));
});
