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
  await tick();
  ui.stdin.write('change it');
  await tick();
  ui.stdin.write('\r');
  for (let i = 0; i < 200 && !ui.lastFrame()?.includes('wants to edit file'); i++) await tick();
  const frame = ui.lastFrame() ?? '';
  assert.match(frame, /wants to edit file/);
  assert.match(frame, /- old line/);
  assert.match(frame, /\+ new line/);
  ui.unmount();
});
