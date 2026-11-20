import type { GuardEnv } from '@santa/contracts';

const DEV_TUNNEL_SUFFIXES = ['.ngrok-free.app', '.ngrok.io'] as const;

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Browser origin allow-list shared by HTTP CORS, Socket.IO and Better Auth.
 * Tunnel suffixes are deliberately parsed as hostnames (not matched as strings) and
 * enabled only outside production.
 */
export function allowedOrigin(
  origin: string,
  baseUrl: string,
  configured: string[] = [],
  env: GuardEnv = 'development',
): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (
    origin === normalizedOrigin(baseUrl) ||
    configured.some((candidate) => normalizedOrigin(candidate) === origin)
  )
    return true;
  if (env === 'production') return false;
  if (url.protocol === 'https:' && DEV_TUNNEL_SUFFIXES.some((s) => url.hostname.endsWith(s)))
    return true;
  return false;
}

/** Exact static origins plus the validated current request origin for Better Auth in dev/test. */
export function trustedOrigins(
  request: Request | undefined,
  baseUrl: string,
  configured: string[],
  env: GuardEnv,
): string[] {
  const origins = [baseUrl, ...configured].map(normalizedOrigin).filter(
    (origin): origin is string => origin !== null,
  );
  const origin = request?.headers.get('origin');
  if (origin && allowedOrigin(origin, baseUrl, configured, env)) origins.push(origin);
  return [...new Set(origins)];
}
