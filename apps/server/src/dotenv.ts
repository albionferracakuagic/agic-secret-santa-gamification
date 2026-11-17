import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Repo root .env: apps/server/{src,dist}/ -> three levels up. */
export const DEFAULT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

/**
 * Loads a .env file into process.env for non-production runs.
 * Real environment variables win (existing keys are never overridden); a missing file is fine.
 */
export function loadDotenv(
  file: string = DEFAULT_ENV_FILE,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['NODE_ENV'] === 'production') return false;
  try {
    for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (env[k] === undefined) env[k] = v;
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
