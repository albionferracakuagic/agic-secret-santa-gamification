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
  EMAIL_TRANSPORT: z.enum(['console']).default('console'),
  /** Set => Azure Blob (managed identity, user-delegation SAS); unset => local FS (dev). */
  STORAGE_ACCOUNT_NAME: Opt,
  STORAGE_CONTAINER: z.string().default('media'),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(source);
  if (env.NODE_ENV === 'production' && (!env.BETTER_AUTH_SECRET || !env.DATABASE_URL)) {
    throw new Error('BETTER_AUTH_SECRET and DATABASE_URL are required in production');
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
