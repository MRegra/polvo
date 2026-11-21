import { open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
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

/**
 * Resolve a model-supplied path against the working directory and refuse
 * anything that escapes it — including via a symlink, by resolving the REAL
 * (link-followed) path and comparing it to the real working directory. The
 * returned value is the resolved real path, safe to stat/open/write.
 *
 * With `mustExist: false` (writing a new file) the target itself may not exist,
 * so its nearest existing ancestor is resolved instead and the boundary is
 * checked against that — a symlinked parent still can't smuggle a write outside.
 */
async function resolveWithin(
  input: unknown,
  mustExist: boolean,
): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('expected a non-empty "path" string');
  }
  const root = await realpath(process.cwd());
  const abs = resolve(root, input);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    if (mustExist) throw new Error(`cannot access path: ${input}`);
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

const MAX_BYTES = 48_000;

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
        text += `\n…[truncated at ${MAX_BYTES} bytes]`;
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
    const abs = await resolveWithin(args.path, false);
    const info = await stat(abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (info && !info.isFile()) {
      throw new Error('refusing to overwrite a non-regular file');
    }
    await writeFile(abs, args.content, 'utf8');
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
