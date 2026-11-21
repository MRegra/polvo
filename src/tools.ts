import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
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

export interface Tool {
  schema: ToolSchema;
  requiresApproval?: boolean; // the agent loop asks the user before running this
  run(args: Record<string, unknown>): Promise<string>;
}

const MAX_BYTES = 48_000;
const TRUNCATION_MARKER = `…[truncated at ${MAX_BYTES} bytes]`;

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
      'Read a UTF-8 text file and return its contents. The path is relative to the working directory.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'file path, relative to the working directory',
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
    // Bounded read via a handle: never slurp a huge (or endless, e.g. /dev/zero)
    // file into memory; a FIFO is already rejected by the isFile() check above.
    const fh = await open(abs, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
      let text = buf.toString('utf8', 0, bytesRead);
      if (info.size > MAX_BYTES) {
        text += `\n${TRUNCATION_MARKER}`;
      }
      return text;
    } finally {
      await fh.close();
    }
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

const writeFileTool: Tool = {
  requiresApproval: true, // the agent loop gates this behind the user's yes
  schema: {
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file with the given full content. The path is relative to the working directory. The user is asked to approve before anything is written.',
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
    if (args.content.includes(TRUNCATION_MARKER)) {
      throw new Error(
        'content still holds a read_file truncation marker — the file was only read in part; refusing to write it back and lose the rest',
      );
    }
    const abs = await resolveWithin(args.path, false);
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
    // Atomic write: write a temp file in the same directory, then rename over
    // the target. rename doesn't follow a symlink and doesn't touch a hardlink's
    // other names, and it never leaves a half-written file on crash/ENOSPC.
    const tmpPath = join(dirname(abs), `.polvo-tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmpPath, args.content, 'utf8');
    try {
      await rename(tmpPath, abs);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
    const lines = args.content.split('\n').length;
    const path = typeof args.path === 'string' ? args.path : '';
    return `wrote ${args.content.length} chars (${lines} line${lines === 1 ? '' : 's'}) to ${path}`;
  },
};

export const TOOLS: Record<string, Tool> = {
  read_file: readFileTool,
  list_dir: listDirTool,
  write_file: writeFileTool,
};

export const TOOL_SCHEMAS: ToolSchema[] = Object.values(TOOLS).map(
  (t) => t.schema,
);
