import type { Env } from './config.js';
import { ConsoleEmailTransport, type EmailTransport } from './email.js';
import { AcsEmailTransport, type AcsSender } from './email-acs.js';

/**
 * Picks the transport from config. Production must use ACS: the console transport prints message bodies
 * (magic links, claim URLs), so it refuses to exist when NODE_ENV=production.
 */
export function createEmailTransport(env: Env, acsSender?: AcsSender): EmailTransport {
  if (env.EMAIL_TRANSPORT === 'acs') {
    if (!env.ACS_ENDPOINT || !env.ACS_SENDER_ADDRESS)
      throw new Error('ACS_ENDPOINT and ACS_SENDER_ADDRESS are required with EMAIL_TRANSPORT=acs');
    return acsSender
      ? new AcsEmailTransport(acsSender, env.ACS_SENDER_ADDRESS)
      : AcsEmailTransport.fromEnv({
          ACS_ENDPOINT: env.ACS_ENDPOINT,
          ACS_SENDER_ADDRESS: env.ACS_SENDER_ADDRESS,
        });
  }
  if (env.NODE_ENV === 'production')
    throw new Error('console email transport is not allowed in production');
  return new ConsoleEmailTransport();
}
