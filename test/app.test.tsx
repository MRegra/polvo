import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/app.tsx';
import type { ChatResult, Provider } from '../src/provider.ts';

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('an edit_file request shows a diff and waits for approval', async () => {
  process.chdir(mkdtempSync(join(tmpdir(), 'polvo-app-')));
  writeFileSync('a.txt', 'old line\n');
  const script: ChatResult[] = [
    { text: '', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { text: '', toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'old line', new_string: 'new line' } }] },
    { text: 'done', toolCalls: [] },
  ];
  const provider: Provider = {
    name: 'fake', model: 'fake', contextTokens: 32_768,
    chat: async () => script.shift() ?? { text: 'done', toolCalls: [] },
  };
  const ui = render(<App provider={provider} config={{ maxSteps: 10, checks: [], maxFixAttempts: 3 }} />);
  await tick(150);
  ui.stdin.write('change it');
  await tick(100);
  ui.stdin.write('\r');
  for (let i = 0; i < 200 && !ui.lastFrame()?.includes('wants to edit file'); i++) await tick();
  const frame = ui.lastFrame() ?? '';
  assert.match(frame, /wants to edit file/);
  assert.match(frame, /- old line/);
  assert.match(frame, /\+ new line/);
  ui.unmount();
});

test('/manual and /status render deterministic harness info without calling the model', async () => {
  let chats = 0;
  const provider: Provider = {
    name: 'fake', model: 'qwen3-coder:30b', contextTokens: 16_384,
    chat: async () => {
      chats++;
      return { text: 'ok', toolCalls: [] };
    },
  };
  const ui1 = render(<App provider={provider} config={{ maxSteps: 10, checks: ['npm test'], maxFixAttempts: 3 }} />);
  await tick(100);
  ui1.stdin.write('/manual');
  await tick(100);
  ui1.stdin.write('\r');
  for (let i = 0; i < 60 && !ui1.lastFrame()?.includes('POLVO_MODEL'); i++) await tick();
  assert.match(ui1.lastFrame() ?? '', /Approval: y = once/);
  assert.match(ui1.lastFrame() ?? '', /POLVO_MODEL/);
  ui1.unmount();

  const ui2 = render(<App provider={provider} config={{ maxSteps: 10, checks: ['npm test'], maxFixAttempts: 3 }} />);
  await tick(100);
  ui2.stdin.write('/status');
  await tick(100);
  ui2.stdin.write('\r');
  for (let i = 0; i < 60 && !ui2.lastFrame()?.includes('checks: npm test'); i++) await tick();
  assert.match(ui2.lastFrame() ?? '', /model: qwen3-coder:30b/);
  assert.match(ui2.lastFrame() ?? '', /checks: npm test/);
  assert.equal(chats, 0);
  ui2.unmount();

  const ui3 = render(<App provider={provider} config={{ maxSteps: 10, checks: ['node -e "process.exit(0)"'], maxFixAttempts: 3 }} />);
  await tick(100);
  ui3.stdin.write('/checks');
  await tick(100);
  ui3.stdin.write('\r');
  for (let i = 0; i < 60 && !ui3.lastFrame()?.includes('✓ node -e'); i++) await tick();
  assert.match(ui3.lastFrame() ?? '', /✓ node -e/);
  assert.equal(chats, 0);
  ui3.unmount();
});
