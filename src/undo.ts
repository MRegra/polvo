import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resetReadState } from './tools.js';

/**
 * In-memory snapshot of files before a turn modifies them, so `/undo` can
 * deterministically restore the working tree to its pre-turn state.
 */
export class TurnSnapshot {
  private readonly originals = new Map<string, Buffer | null>();

  constructor(private readonly root: string = process.cwd()) {}

  private resolveSafe(input: string): string | null {
    const abs = resolve(this.root, input);
    const rel = relative(this.root, abs);
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
      return null;
    }
    return abs;
  }

  /** Capture a file's original bytes the first time this turn touches it. */
  capture(input: string): void {
    const abs = this.resolveSafe(input);
    if (!abs || this.originals.has(abs)) return;
    try {
      this.originals.set(abs, existsSync(abs) ? readFileSync(abs) : null);
    } catch {
      // Unreadable or non-regular file: skip snapshotting.
    }
  }

  hasChanges(): boolean {
    return this.originals.size > 0;
  }

  /** Restore every snapshotted file and return their relative paths. */
  restore(): string[] {
    const restored: string[] = [];
    for (const [abs, bytes] of this.originals) {
      if (bytes === null) {
        rmSync(abs, { force: true });
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
      }
      restored.push(relative(this.root, abs).split(sep).join('/') || abs);
    }
    this.originals.clear();
    if (restored.length > 0) resetReadState();
    return restored.sort();
  }
}
