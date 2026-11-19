import { z } from 'zod';

const Opt = z.string().min(1).optional();

/** Secrets come from the environment (Key Vault in Azure). See .env.example. */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: Opt,
  BETTER_AUTH_URL: z.url().default('http://localhost:3000'),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: Opt,
  GOOGLE_CLIENT_SECRET: Opt,
  MICROSOFT_CLIENT_ID: Opt,
  MICROSOFT_CLIENT_SECRET: Opt,
  MICROSOFT_TENANT_ID: Opt,
  EMAIL_TRANSPORT: z.enum(['console', 'acs']).default('console'),
  /** Azure Communication Services Email (managed identity auth; no connection string). */
  ACS_ENDPOINT: z.url().optional(),
  ACS_SENDER_ADDRESS: z.email().optional(),
  /** Exact number of trusted reverse-proxy hops (Container Apps ingress = 1). 0 = trust none. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** Built SPA directory served by this server (unset = API only). */
  WEB_DIST: Opt,
  /** Comma-separated emails promoted to platform admin when verified. */
  PLATFORM_ADMIN_EMAILS: Opt,
  /** Set => Azure Blob (managed identity, user-delegation SAS); unset => local FS (dev). */
  STORAGE_ACCOUNT_NAME: Opt,
  STORAGE_CONTAINER: z.string().default('media'),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // .env.example ships empty values (KEY=): treat blank as unset
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const env = EnvSchema.parse(cleaned);
  if (env.NODE_ENV === 'production' && (!env.BETTER_AUTH_SECRET || !env.DATABASE_URL)) {
    throw new Error('BETTER_AUTH_SECRET and DATABASE_URL are required in production');
  }
  if (env.NODE_ENV === 'production') {
    // the console transport prints magic links / claim URLs: never acceptable outside dev
    if (env.EMAIL_TRANSPORT !== 'acs')
      throw new Error(
        'EMAIL_TRANSPORT=acs is required in production (console transport is dev-only)',
      );
    if (!env.ACS_ENDPOINT || !env.ACS_SENDER_ADDRESS)
      throw new Error('ACS_ENDPOINT and ACS_SENDER_ADDRESS are required with EMAIL_TRANSPORT=acs');
  }
  return env;
}

export function socialFromEnv(env: Env) {
  return {
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
    microsoft:
      env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
        ? {
            clientId: env.MICROSOFT_CLIENT_ID,
            clientSecret: env.MICROSOFT_CLIENT_SECRET,
            tenantId: env.MICROSOFT_TENANT_ID,
          }
        : undefined,
  };
}
