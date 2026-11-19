import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { account, session, user, verification, type Db } from '@santa/db';
import type { EmailTransport } from './email.js';

export interface SocialCreds {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  db: Db;
  baseURL: string;
  /** >= 32 chars; from Key Vault in Azure. Never committed. */
  secret: string;
  email: EmailTransport;
  trustedOrigins?:
    | string[]
    | ((request?: Request) => string[] | Promise<string[]>);
  google?: SocialCreds | undefined;
  microsoft?: (SocialCreds & { tenantId?: string | undefined }) | undefined;
  /** Better Auth built-in limiter; magic-link sends are the abuse-prone endpoint. */
  rateLimit?: { window: number; max: number; magicLink: { window: number; max: number } };
  secureCookies?: boolean;
}

/** Set by registerAuthRoutes from 
eq.ip (which honours only the configured proxy hop count). */
export const TRUSTED_IP_HEADER = 'x-sg-client-ip';

export function createAuth(cfg: AuthConfig) {
  const rl = cfg.rateLimit ?? { window: 60, max: 100, magicLink: { window: 60, max: 5 } };
  return betterAuth({
    baseURL: cfg.baseURL,
    secret: cfg.secret,
    trustedOrigins: cfg.trustedOrigins ?? [cfg.baseURL],
    database: drizzleAdapter(cfg.db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
    user: {
      additionalFields: {
        // set only by direct DB/admin action; never accepted from clients
        isPlatformAdmin: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    socialProviders: {
      ...(cfg.google ? { google: cfg.google } : {}),
      ...(cfg.microsoft
        ? {
            microsoft: {
              clientId: cfg.microsoft.clientId,
              clientSecret: cfg.microsoft.clientSecret,
              ...(cfg.microsoft.tenantId ? { tenantId: cfg.microsoft.tenantId } : {}),
            },
          }
        : {}),
    },
    plugins: [
      magicLink({
        expiresIn: 600,
        sendMagicLink: async ({ email, url }) => {
          await cfg.email.send({
            to: email,
            subject: 'Your Secret Santa Games sign-in link',
            text: `Sign in: ${url}\n\nThe link expires in 10 minutes. If you did not request it, ignore this email.`,
          });
        },
      }),
    ],
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: rl.window,
      max: rl.max,
      customRules: { '/sign-in/magic-link': rl.magicLink },
    },
    advanced: {
      cookiePrefix: 'sg',
      useSecureCookies: cfg.secureCookies ?? cfg.baseURL.startsWith('https://'),
      // only the header our Fastify layer sets from the trusted client IP (never a raw client-supplied X-Forwarded-For)
      ipAddress: { ipAddressHeaders: [TRUSTED_IP_HEADER] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
