import {
  lstat,
  readdir,
  realpath,
  rename,
  readFile,
  chmod,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { ToolSchema } from './provider.js';
import { isAutoApproved, parseCommand, runArgv } from './command.js';
import { collectSnapshot, evaluate } from './monitor.js';

export interface Tool {
  schema: ToolSchema;
  /** The agent loop asks the user first: always (true) or per call. */
  requiresApproval?: boolean | ((args: Record<string, unknown>) => boolean);
  /** Changes files; the harness runs the project's checks after such a turn. */
  mutates?: boolean | ((args: Record<string, unknown>) => boolean);
  run(args: Record<string, unknown>): Promise<string>;
}

const MAX_BYTES = 16_000;
const TRUNCATION_PREFIX = '…[truncated';
/** Files bigger than this are refused outright (read and edit). */
const MAX_FILE_BYTES = 2_000_000;

/**
 * Files the model has read this session, with the mtime it saw. Editing or
 * overwriting a file requires a read first, and refuses if the file changed on
 * disk since (the user edited it, or a formatter ran) — the model would be
 * working from a stale copy.
 */
const readState = new Map<string, number>();

export function resetReadState(): void {
  readState.clear();
}

async function requireFreshRead(abs: string, input: string): Promise<void> {
  const seen = readState.get(abs);
  if (seen === undefined) {
    throw new Error(`read ${input} with read_file before changing it`);
  }
  const { mtimeMs } = await stat(abs);
  if (mtimeMs !== seen) {
    throw new Error(`${input} changed on disk since you read it — read it again first`);
  }
}

/**
 * Resolve a model-supplied path against the working directory and refuse
 * anything that escapes it — including via a symlink, by resolving the REAL
 * (link-followed) path and comparing it to the real working directory. The
 * returned value is the resolved real path, safe to stat/open.
 *
 * With `mustExist: false` (writing a new file) the target itself may not exist,
 * so its nearest existing ancestor is resolved instead and the boundary is
 * checked against that. A broken/dangling symlink is refused outright: its
 * target is missing so it looks "absent", but following it would escape.
 */
async function resolveWithin(
  input: unknown,
  mustExist: boolean,
): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('expected a non-empty "path" string');
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)) {
    // control chars AND Unicode format/bidi chars (RTL override, zero-width) —
    // both can spoof the approval prompt or hide the true target.
    throw new Error('path contains control characters');
  }
  const root = await realpath(process.cwd());
  const abs = resolve(root, input);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (mustExist) throw new Error(`cannot access path: ${input}`);
    // realpath failed with ENOENT: either truly absent, or a dangling symlink
    // (the link exists but its target doesn't). lstat tells them apart; refuse
    // the dangling link, since writing would follow it outside the cwd.
    const link = await lstat(abs).catch(() => null);
    if (link) throw new Error(`refusing to follow a broken symlink: ${input}`);
    let realParent: string;
    try {
      realParent = await realpath(dirname(abs));
    } catch {
      throw new Error(`parent directory does not exist: ${input}`);
    }
    real = join(realParent, basename(abs));
  }
  const rel = relative(root, real);
  if (
    rel !== '' &&
    (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  ) {
    throw new Error(`path escapes the working directory: ${input}`);
  }
  return real;
}

const readFileTool: Tool = {
  schema: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file. Long files come back in pages: pass start_line (1-based) to continue where the previous page stopped.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'file path, relative to the working directory',
        },
        start_line: {
          type: 'number',
          description: 'first line to return (1-based, default 1)',
        },
      },
      required: ['path'],
    },
  },
  async run(args) {
    const abs = await resolveWithin(args.path, true);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error('not a regular file');
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`file is ${info.size} bytes — too large to read (limit ${MAX_FILE_BYTES})`);
    }
    const startLine =
      args.start_line === undefined ? 1 : Number(args.start_line);
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error('start_line must be a positive integer');
    }
    // isFile() above already rejects FIFOs and devices, and the size cap keeps
    // the full read bounded.
    const all = await readFile(abs, 'utf8');
    readState.set(abs, info.mtimeMs);
    const lines = all.split('\n');
    if (startLine > lines.length) {
      throw new Error(`start_line ${startLine} is past the end (${lines.length} lines)`);
    }
    let out = '';
    let i = startLine - 1;
    for (; i < lines.length; i++) {
      const next = (out ? '\n' : '') + lines[i];
      if (out && out.length + next.length > MAX_BYTES) break;
      out += next;
    }
    if (i < lines.length) {
      out += `\n${TRUNCATION_PREFIX} at line ${i} of ${lines.length} — call read_file with start_line=${i + 1} to continue]`;
    }
    return out;
  },
};

const listDirTool: Tool = {
  schema: {
    name: 'list_dir',
    description:
      'List the entries of a directory. The path is relative to the working directory and defaults to ".".',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'directory path, relative to the working directory',
        },
      },
      required: [],
    },
  },
  async run(args) {
    const input =
      typeof args.path === 'string' && args.path.trim() !== ''
        ? args.path
        : '.';
    const abs = await resolveWithin(input, true);
    const info = await stat(abs);
    if (!info.isDirectory()) {
      throw new Error('not a directory');
    }
    const entries = await readdir(abs, { withFileTypes: true });
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return lines.length ? lines.join('\n') : '(empty directory)';
  },
};

/** Refuse targets the model must never write: .git internals, symlinks, non-files. */
async function writableTarget(input: unknown): Promise<{ abs: string; exists: boolean }> {
  const abs = await resolveWithin(input, false);
  const root = await realpath(process.cwd());
  if (
    relative(root, abs)
      .split(sep)
      .some((s) => s.toLowerCase() === '.git')
  ) {
    throw new Error('refusing to write inside a .git directory');
  }
  const info = await lstat(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (info) {
    if (info.isSymbolicLink()) {
      throw new Error('refusing to write through a symlink');
    }
    if (!info.isFile()) {
      throw new Error('refusing to overwrite a non-regular file');
    }
  }
  return { abs, exists: info !== null };
}

/**
 * Atomic write: write a temp file in the same directory, then rename over the
 * target. rename doesn't follow a symlink or touch a hardlink's other names,
 * and never leaves a half-written file on crash/ENOSPC. Keeps the old mode.
 */
async function atomicWrite(abs: string, content: string): Promise<void> {
  const mode = await stat(abs).then((i) => i.mode & 0o7777, () => undefined);
  const tmpPath = join(dirname(abs), `.polvo-tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmpPath, content, 'utf8');
  try {
    // writeFile's `mode` is filtered by the umask; chmod sets it exactly.
    if (mode !== undefined) await chmod(tmpPath, mode);
    await rename(tmpPath, abs);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  readState.set(abs, (await stat(abs)).mtimeMs);
}

function rejectTruncationMarker(text: string): void {
  if (text.includes(TRUNCATION_PREFIX) && text.includes('call read_file with start_line=')) {
    throw new Error(
      'content holds a read_file page marker — that was only part of the file; refusing to write it back and lose the rest',
    );
  }
}

const writeFileTool: Tool = {
  requiresApproval: true,
  mutates: true,
  schema: {
    name: 'write_file',
    description:
      'Create a new UTF-8 text file, or completely rewrite a small existing one (read it first). To change part of a file use edit_file. The user approves every write.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'file path, relative to the working directory',
        },
        content: {
          type: 'string',
          description: 'the complete new contents of the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  async run(args) {
    if (typeof args.content !== 'string') {
      throw new Error('expected a "content" string');
    }
    rejectTruncationMarker(args.content);
    const path = String(args.path);
    const { abs, exists } = await writableTarget(args.path);
    if (exists) {
      await requireFreshRead(abs, path);
      // Wiping a file is almost never the intent; weak models do it by
      // accident (calling write_file with no content) and then report success.
      if (args.content.trim() === '' && (await stat(abs)).size > 0) {
        throw new Error(
          `refusing to replace ${path} with empty content — to change part of it use edit_file; write_file needs the complete new contents`,
        );
      }
    }
    await atomicWrite(abs, args.content);
    const lines = args.content.split('\n').length;
    return `${exists ? 'overwrote' : 'created'} ${path} (${lines} line${lines === 1 ? '' : 's'})`;
  },
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    count++;
  }
  return count;
}

const editFileTool: Tool = {
  requiresApproval: true,
  mutates: true,
  schema: {
    name: 'edit_file',
    description:
      'Replace an exact snippet in an existing file. old_string must match the file exactly (whitespace and indentation included) and occur exactly once — add surrounding lines to make it unique, or set replace_all. Read the file first. The user approves every edit.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'file path, relative to the working directory',
        },
        old_string: {
          type: 'string',
          description: 'the exact text to replace',
        },
        new_string: {
          type: 'string',
          description: 'the replacement text',
        },
        replace_all: {
          type: 'boolean',
          description: 'replace every occurrence instead of requiring exactly one',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  async run(args) {
    if (typeof args.old_string !== 'string' || args.old_string === '') {
      throw new Error('old_string must be a non-empty string (use write_file to create a file)');
    }
    if (typeof args.new_string !== 'string') throw new Error('expected a "new_string" string');
    let oldStr: string = args.old_string;
    let newStr: string = args.new_string;
    if (oldStr === newStr) throw new Error('old_string and new_string are identical — nothing to change');
    rejectTruncationMarker(newStr);

    const path = String(args.path);
    const { abs, exists } = await writableTarget(args.path);
    if (!exists) throw new Error(`${path} does not exist — use write_file to create it`);
    await requireFreshRead(abs, path);
    const info = await stat(abs);
    if (info.size > MAX_FILE_BYTES) throw new Error(`file is too large to edit (${info.size} bytes)`);
    const original = await readFile(abs, 'utf8');

    // A CRLF file read through the model usually comes back with LF only.
    if (original.includes('\r\n') && !oldStr.includes('\r')) {
      oldStr = oldStr.replace(/\n/g, '\r\n');
      newStr = newStr.replace(/\r?\n/g, '\r\n');
    }

    const count = countOccurrences(original, oldStr);
    if (count === 0) {
      throw new Error(
        `old_string not found in ${path}. It must match exactly, including indentation and line breaks — read the file again and copy the text verbatim.`,
      );
    }
    if (count > 1 && args.replace_all !== true) {
      throw new Error(
        `old_string occurs ${count} times in ${path}. Include more surrounding lines so it is unique, or set replace_all to true.`,
      );
    }
    // split/join, not String.replace: a "$&" or "$1" in new_string must stay literal.
    const updated =
      args.replace_all === true
        ? original.split(oldStr).join(newStr)
        : original.slice(0, original.indexOf(oldStr)) +
          newStr +
          original.slice(original.indexOf(oldStr) + oldStr.length);
    await atomicWrite(abs, updated);
    return `edited ${path} (${count} replacement${count === 1 ? '' : 's'})`;
  },
};

/** Parse once for the approval decision; a parse error means "don't ask, just fail". */
function autoApproved(args: Record<string, unknown>): boolean | null {
  try {
    return isAutoApproved(parseCommand(String(args.command ?? '')));
  } catch {
    return null;
  }
}

const runCommandTool: Tool = {
  requiresApproval: (args) => autoApproved(args) === false,
  mutates: (args) => autoApproved(args) === false,
  schema: {
    name: 'run_command',
    description:
      'Run one program in the project directory, without a shell: no pipes, redirects, &&, globs or $VARS. Read-only commands (ls, cat, grep, rg, find, git status/diff/log, ps, df, free, systemctl status, journalctl …) run directly; anything else asks the user. 60 s timeout; long output is cut in the middle.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'the command line, e.g. "git diff --stat" or "npm test"',
        },
      },
      required: ['command'],
    },
  },
  async run(args) {
    if (typeof args.command !== 'string') throw new Error('expected a "command" string');
    const argv = parseCommand(args.command);
    const r = await runArgv(argv);
    const status = r.timedOut ? 'timed out after 60 s' : `exit ${r.exitCode}`;
    return `${status}\n${r.output || '(no output)'}`;
  },
};

const systemSnapshotTool: Tool = {
  schema: {
    name: 'system_snapshot',
    description:
      'Current state of this machine: memory, swap, load, disk usage, failed systemd units, errors logged in the last hour, top processes by memory, loaded Ollama models — plus alerts from fixed thresholds. Use it to answer questions about system health.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run() {
    const snap = await collectSnapshot();
    return JSON.stringify({ alerts: evaluate(snap), ...snap }, null, 1);
  },
};

export const TOOLS: Record<string, Tool> = {
  read_file: readFileTool,
  list_dir: listDirTool,
  edit_file: editFileTool,
  write_file: writeFileTool,
  run_command: runCommandTool,
  system_snapshot: systemSnapshotTool,
};

export const TOOL_SCHEMAS: ToolSchema[] = Object.values(TOOLS).map(
  (t) => t.schema,
);
