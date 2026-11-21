import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolSchema } from './provider.js';

export interface Tool {
  schema: ToolSchema;
  run(args: Record<string, unknown>): Promise<string>;
}

/**
 * Resolve a model-supplied path against the working directory and refuse
 * anything that escapes it. This is the one safety boundary for the read-only
 * tools — the model can only see files at or below where polvo was launched.
 */
function safePath(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('expected a non-empty "path" string');
  }
  const root = process.cwd();
  const abs = resolve(root, input);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the working directory: ${input}`);
  }
  return abs;
}

const MAX_CHARS = 50_000;

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
    const abs = safePath(args.path);
    const data = await readFile(abs, 'utf8');
    return data.length > MAX_CHARS
      ? `${data.slice(0, MAX_CHARS)}\n…[truncated at ${MAX_CHARS} chars]`
      : data;
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
    const abs = safePath(input);
    const entries = await readdir(abs, { withFileTypes: true });
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return lines.length ? lines.join('\n') : '(empty directory)';
  },
};

export const TOOLS: Record<string, Tool> = {
  read_file: readFileTool,
  list_dir: listDirTool,
};

export const TOOL_SCHEMAS: ToolSchema[] = Object.values(TOOLS).map(
  (t) => t.schema,
);
