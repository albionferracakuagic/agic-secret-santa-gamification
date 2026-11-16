import { fileURLToPath } from 'node:url';

/** Works from src (tsx/vitest) and dist (compiled): both sit one level below the package root. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));
