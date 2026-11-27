import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message } from './provider.js';

export interface SavedSession {
  cwd: string;
  updatedAt: string;
  messages: Message[];
}

function sessionFile(cwd: string, stateDir: string): string {
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return join(stateDir, `${key}.json`);
}

function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'polvo', 'sessions');
}

export function saveSession(
  cwd: string,
  messages: Message[],
  stateDir: string = defaultStateDir(),
): void {
  if (messages.length === 0) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    const data: SavedSession = {
      cwd,
      updatedAt: new Date().toISOString(),
      messages,
    };
    writeFileSync(sessionFile(cwd, stateDir), JSON.stringify(data), 'utf8');
  } catch {
    // Non-fatal: e.g. read-only state dir in sandbox
  }
}

export function loadSession(
  cwd: string,
  stateDir: string = defaultStateDir(),
): SavedSession | null {
  try {
    const raw = readFileSync(sessionFile(cwd, stateDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SavedSession>;
    if (!parsed || !Array.isArray(parsed.messages) || typeof parsed.updatedAt !== 'string') {
      return null;
    }
    return {
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : cwd,
      updatedAt: parsed.updatedAt,
      messages: parsed.messages as Message[],
    };
  } catch {
    return null;
  }
}
