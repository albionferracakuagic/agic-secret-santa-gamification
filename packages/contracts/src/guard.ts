import type { Role } from './common.js';
import { OutputSchemas, type Surface } from './output.js';

export class PrivacyViolationError extends Error {
  constructor(
    readonly role: Role,
    readonly surface: Surface,
    readonly issues: string[],
  ) {
    super(`output violates ${role}/${surface} schema: ${issues.join('; ')}`);
  }
}

export type GuardEnv = 'development' | 'test' | 'production';
export interface SendGuardOptions {
  env: GuardEnv;
  /** Called on every violation (prod: wire to App Insights alert). Must not log payload values. */
  alert?: (v: PrivacyViolationError) => void;
}

type PathKey = string | number | symbol;

function deleteAt(root: unknown, path: readonly PathKey[], key: string): void {
  let cur = root as Record<PathKey, unknown> | undefined;
  for (const p of path) cur = cur?.[p] as Record<PathKey, unknown> | undefined;
  if (cur && typeof cur === 'object') delete cur[key];
}

/**
 * Validate a projected payload against the strict role schema.
 * development/test: throw. production: strip unrecognized keys + alert; anything else invalid -> throw (drop).
 */
export function guardOutput(
  role: Role,
  surface: Surface,
  payload: unknown,
  opts: SendGuardOptions,
): unknown {
  const schema = OutputSchemas[role][surface];
  let candidate = payload;
  let violation: PrivacyViolationError | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = schema.safeParse(candidate);
    if (res.success) {
      if (violation) opts.alert?.(violation);
      return res.data;
    }
    const issues = res.error.issues;
    violation ??= new PrivacyViolationError(
      role,
      surface,
      issues.map((i) => `${i.code}@${i.path.join('.')}`),
    );
    const onlyUnknownKeys = issues.every((i) => i.code === 'unrecognized_keys');
    if (opts.env !== 'production' || !onlyUnknownKeys) break;
    candidate = JSON.parse(JSON.stringify(candidate));
    for (const i of issues) {
      if (i.code === 'unrecognized_keys') {
        for (const k of i.keys) deleteAt(candidate, i.path, k);
      }
    }
  }
  opts.alert?.(violation!);
  throw violation!;
}

export const createSendGuard = (opts: SendGuardOptions) => ({
  guard: (role: Role, surface: Surface, payload: unknown) =>
    guardOutput(role, surface, payload, opts),
});

export interface ForbiddenScan {
  values?: readonly string[];
  keys?: readonly string[];
}

/** Test/contract util: returns JSON-paths where a forbidden key or value substring appears. */
export function scanForbidden(payload: unknown, forbidden: ForbiddenScan): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      for (const v of forbidden.values ?? []) if (node.includes(v)) hits.push(`${path}="${v}"`);
    } else if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        for (const fk of forbidden.keys ?? []) if (k === fk) hits.push(`${path}.${k}`);
        for (const fv of forbidden.values ?? []) if (k.includes(fv)) hits.push(`${path}.${k}(key)`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(payload, '$');
  return hits;
}
