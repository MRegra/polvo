import { readFile, statfs } from 'node:fs/promises';
import { cpus, homedir } from 'node:os';
import { runArgv } from './command.js';

/**
 * System monitoring without the model: collectors read the facts, plain rules
 * decide what's wrong. The model is only asked to explain a snapshot (via the
 * system_snapshot tool), so `polvo monitor` works from cron with no LLM loaded.
 */

export interface Snapshot {
  time: string;
  memory?: { totalMB: number; availableMB: number; swapTotalMB: number; swapFreeMB: number };
  /** Linux PSI: % of the last 10 s some task stalled waiting for memory. */
  memoryPressure?: { someAvg10: number; fullAvg10: number };
  load?: { load1: number; load5: number; load15: number; cores: number };
  disks: Array<{ mount: string; usedPct: number; freeGB: number }>;
  failedUnits: string[];
  recentErrors: string[];
  topProcesses: Array<{ pid: number; rssMB: number; command: string }>;
  ollama?: Array<{ model: string; sizeMB: number }>;
  /** Collectors that failed, so a missing section is explained, not silent. */
  unavailable: string[];
}

export interface Alert {
  level: 'warn' | 'critical';
  message: string;
}

export interface Thresholds {
  memAvailablePctWarn: number;
  memAvailablePctCritical: number;
  swapUsedPctWarn: number;
  diskUsedPctWarn: number;
  diskUsedPctCritical: number;
  loadPerCoreWarn: number;
  memPressureSomeWarn: number;
  memPressureFullCritical: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  memAvailablePctWarn: 15,
  memAvailablePctCritical: 5,
  swapUsedPctWarn: 50,
  diskUsedPctWarn: 85,
  diskUsedPctCritical: 95,
  loadPerCoreWarn: 1.5,
  memPressureSomeWarn: 20,
  memPressureFullCritical: 10,
};

/** Pure: the same snapshot always yields the same alerts. */
export function evaluate(s: Snapshot, t: Thresholds = DEFAULT_THRESHOLDS): Alert[] {
  const alerts: Alert[] = [];
  if (s.memory && s.memory.totalMB > 0) {
    const pct = (s.memory.availableMB / s.memory.totalMB) * 100;
    if (pct < t.memAvailablePctCritical) {
      alerts.push({ level: 'critical', message: `memory: only ${pct.toFixed(1)}% available (${s.memory.availableMB} MB)` });
    } else if (pct < t.memAvailablePctWarn) {
      alerts.push({ level: 'warn', message: `memory: ${pct.toFixed(1)}% available (${s.memory.availableMB} MB)` });
    }
    if (s.memory.swapTotalMB > 0) {
      const swapPct = ((s.memory.swapTotalMB - s.memory.swapFreeMB) / s.memory.swapTotalMB) * 100;
      if (swapPct > t.swapUsedPctWarn) {
        alerts.push({ level: 'warn', message: `swap: ${swapPct.toFixed(0)}% used` });
      }
    }
  }
  if (s.memoryPressure) {
    const { someAvg10, fullAvg10 } = s.memoryPressure;
    if (fullAvg10 >= t.memPressureFullCritical) {
      alerts.push({ level: 'critical', message: `memory pressure: all tasks stalled ${fullAvg10}% of the last 10 s` });
    } else if (someAvg10 >= t.memPressureSomeWarn) {
      alerts.push({ level: 'warn', message: `memory pressure: tasks stalled ${someAvg10}% of the last 10 s` });
    }
  }
  for (const d of s.disks) {
    if (d.usedPct >= t.diskUsedPctCritical) {
      alerts.push({ level: 'critical', message: `disk ${d.mount}: ${d.usedPct}% used (${d.freeGB} GB free)` });
    } else if (d.usedPct >= t.diskUsedPctWarn) {
      alerts.push({ level: 'warn', message: `disk ${d.mount}: ${d.usedPct}% used (${d.freeGB} GB free)` });
    }
  }
  if (s.load && s.load.cores > 0 && s.load.load5 / s.load.cores > t.loadPerCoreWarn) {
    alerts.push({ level: 'warn', message: `load: ${s.load.load5.toFixed(2)} (5 min) on ${s.load.cores} cores` });
  }
  for (const unit of s.failedUnits) {
    alerts.push({ level: 'critical', message: `failed unit: ${unit}` });
  }
  return alerts;
}

// ---------------------------------------------------------------- collectors

const MAX_ERRORS = 15;

export function parseMeminfo(text: string): Snapshot['memory'] {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  const mb = (v: number): number => Math.round(v / 1024);
  return {
    totalMB: mb(kb('MemTotal')),
    availableMB: mb(kb('MemAvailable')),
    swapTotalMB: mb(kb('SwapTotal')),
    swapFreeMB: mb(kb('SwapFree')),
  };
}

/** /proc/pressure/memory → avg10 of the "some" and "full" lines. */
export function parsePressure(text: string): Snapshot['memoryPressure'] {
  const avg = (kind: string): number => {
    const m = new RegExp(`^${kind} avg10=([0-9.]+)`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return { someAvg10: avg('some'), fullAvg10: avg('full') };
}

/** `ps -eo pid=,rss=,comm=` → biggest processes by resident memory. */
export function parsePs(text: string, limit = 5): Snapshot['topProcesses'] {
  return text
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), rssMB: Math.round(Number(m[2]) / 1024), command: m[3].trim() }))
    .sort((a, b) => b.rssMB - a.rssMB)
    .slice(0, limit);
}

async function lines(argv: string[]): Promise<string[]> {
  const r = await runArgv(argv, { timeoutMs: 10_000 });
  if (r.exitCode !== 0) throw new Error(r.output.slice(0, 200));
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function collectSnapshot(
  ollamaHost: string = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
): Promise<Snapshot> {
  const snap: Snapshot = {
    time: new Date().toISOString(),
    disks: [],
    failedUnits: [],
    recentErrors: [],
    topProcesses: [],
    unavailable: [],
  };
  const attempt = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch {
      snap.unavailable.push(name);
    }
  };

  await Promise.all([
    attempt('memory', async () => {
      snap.memory = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
    }),
    attempt('memoryPressure', async () => {
      snap.memoryPressure = parsePressure(await readFile('/proc/pressure/memory', 'utf8'));
    }),
    attempt('load', async () => {
      const [l1, l5, l15] = (await readFile('/proc/loadavg', 'utf8')).split(' ').map(Number);
      snap.load = { load1: l1, load5: l5, load15: l15, cores: cpus().length };
    }),
    attempt('disks', async () => {
      const seen = new Set<string>();
      for (const mount of ['/', homedir()]) {
        const s = await statfs(mount);
        // btrfs subvolumes (Fedora's / and /home) have different st_dev but
        // report the same pool; identical totals mean the same filesystem.
        const key = `${s.blocks}:${s.bfree}:${s.bsize}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        if (total === 0) continue;
        snap.disks.push({
          mount,
          usedPct: Math.round(((total - free) / total) * 100),
          freeGB: Math.round(free / 1e9),
        });
      }
    }),
    attempt('failedUnits', async () => {
      const sys = await lines(['systemctl', '--failed', '--no-legend', '--plain']);
      const user = await lines(['systemctl', '--user', '--failed', '--no-legend', '--plain']).catch(() => []);
      snap.failedUnits = [...sys, ...user.map((u) => `${u} (user)`)].map((l) => l.split(/\s+/)[0]!);
    }),
    attempt('recentErrors', async () => {
      const errs = await lines(['journalctl', '-p', 'err', '--since', '-1h', '-n', String(MAX_ERRORS), '-o', 'short', '-q']);
      snap.recentErrors = errs.map((l) => l.slice(0, 200));
    }),
    attempt('topProcesses', async () => {
      const r = await runArgv(['ps', '-eo', 'pid=,rss=,comm='], { timeoutMs: 10_000 });
      snap.topProcesses = parsePs(r.stdout);
    }),
    attempt('ollama', async () => {
      const res = await fetch(`${ollamaHost.replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(3000) });
      const data = (await res.json()) as { models?: Array<{ name: string; size: number }> };
      snap.ollama = (data.models ?? []).map((m) => ({ model: m.name, sizeMB: Math.round(m.size / 1e6) }));
    }),
  ]);
  snap.unavailable.sort();
  return snap;
}

/** Human-readable report for `polvo monitor`. */
export function formatReport(s: Snapshot, alerts: Alert[]): string {
  const out: string[] = [`polvo monitor — ${s.time}`];
  if (s.memory) {
    out.push(`memory   ${s.memory.availableMB} / ${s.memory.totalMB} MB available` +
      (s.memory.swapTotalMB ? `, swap ${s.memory.swapTotalMB - s.memory.swapFreeMB} / ${s.memory.swapTotalMB} MB used` : ''));
  }
  if (s.memoryPressure) out.push(`pressure memory some ${s.memoryPressure.someAvg10}% · full ${s.memoryPressure.fullAvg10}% (avg 10 s)`);
  if (s.load) out.push(`load     ${s.load.load1} ${s.load.load5} ${s.load.load15} (${s.load.cores} cores)`);
  for (const d of s.disks) out.push(`disk     ${d.mount}: ${d.usedPct}% used, ${d.freeGB} GB free`);
  if (s.ollama) {
    out.push(`ollama   ${s.ollama.length ? s.ollama.map((m) => `${m.model} (${m.sizeMB} MB)`).join(', ') : 'no model loaded'}`);
  }
  if (s.topProcesses.length) {
    out.push('top RSS  ' + s.topProcesses.map((p) => `${p.command} ${p.rssMB}MB`).join(' · '));
  }
  if (s.recentErrors.length) out.push(`errors   ${s.recentErrors.length}${s.recentErrors.length >= MAX_ERRORS ? '+' : ''} in the last hour (journalctl -p err --since -1h)`);
  if (s.unavailable.length) out.push(`n/a      ${s.unavailable.join(', ')}`);
  out.push('');
  out.push(alerts.length ? alerts.map((a) => `${a.level === 'critical' ? '✗' : '!'} ${a.message}`).join('\n') : '✓ no alerts');
  return out.join('\n');
}
