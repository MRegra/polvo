
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

const LOG_DIR = join(homedir(), '.polvo', 'logs');

export const DIAGNOSTIC_LOG = join(
  LOG_DIR,
  'polvo-debug.log',
);

export async function logDiagnostic(
  component: string,
  error: unknown,
  details: Record<string, unknown> = {},
): Promise<void> {
  const timestamp = new Date().toISOString();

  const errorDetails = inspect(error, {
    depth: 10,
    colors: false,
    compact: false,
    showHidden: true,
  });

  const context = inspect(details, {
    depth: 5,
    colors: false,
    compact: false,
  });

  const entry = [
    '',
    '==================================================',
    `TIMESTAMP: ${timestamp}`,
    `COMPONENT: ${component}`,
    'ERROR:',
    errorDetails,
    'CONTEXT:',
    context,
    '==================================================',
    '',
  ].join('\n');

  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(DIAGNOSTIC_LOG, entry, 'utf8');
  } catch (loggingError) {
    process.stderr.write(
      `Polvo: could not write diagnostic log: ${
        loggingError instanceof Error
          ? loggingError.message
          : String(loggingError)
      }\n`,
    );
  }
}
