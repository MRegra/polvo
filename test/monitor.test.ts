import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parseMeminfo, parsePressure, parsePs, type Snapshot } from '../src/monitor.ts';

const base: Snapshot = { time: 't', disks: [], failedUnits: [], recentErrors: [], topProcesses: [], unavailable: [] };

test('parsers', () => {
  assert.deepEqual(parseMeminfo('MemTotal: 2048000 kB\nMemAvailable: 1024000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n'),
    { totalMB: 2000, availableMB: 1000, swapTotalMB: 0, swapFreeMB: 0 });
  assert.deepEqual(parsePressure('some avg10=12.50 avg60=1 avg300=0 total=1\nfull avg10=3.00 avg60=0 avg300=0 total=1\n'),
    { someAvg10: 12.5, fullAvg10: 3 });
  assert.deepEqual(parsePs('  10  2048 node\n  11 409600 ollama runner\n').map((p) => p.command), ['ollama runner', 'node']);
});

test('evaluate is quiet when healthy and flags each threshold', () => {
  const healthy: Snapshot = { ...base, memory: { totalMB: 1000, availableMB: 500, swapTotalMB: 0, swapFreeMB: 0 },
    load: { load1: 1, load5: 1, load15: 1, cores: 8 }, disks: [{ mount: '/', usedPct: 50, freeGB: 100 }] };
  assert.deepEqual(evaluate(healthy), []);
  const sick: Snapshot = { ...healthy, memory: { totalMB: 1000, availableMB: 30, swapTotalMB: 100, swapFreeMB: 10 },
    memoryPressure: { someAvg10: 30, fullAvg10: 0 }, load: { load1: 20, load5: 20, load15: 20, cores: 8 },
    disks: [{ mount: '/', usedPct: 97, freeGB: 1 }], failedUnits: ['foo.service'] };
  const msgs = evaluate(sick).map((a) => `${a.level} ${a.message}`);
  assert.ok(msgs.some((m) => m.startsWith('critical memory')));
  assert.ok(msgs.some((m) => m.startsWith('warn swap')));
  assert.ok(msgs.some((m) => m.startsWith('warn memory pressure')));
  assert.ok(msgs.some((m) => m.startsWith('critical disk')));
  assert.ok(msgs.some((m) => m.startsWith('warn load')));
  assert.ok(msgs.some((m) => m === 'critical failed unit: foo.service'));
});
