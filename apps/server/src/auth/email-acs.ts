import { DefaultAzureCredential } from '@azure/identity';
import { EmailClient } from '@azure/communication-email';
import type { EmailMessage, EmailTransport } from './email.js';

/** The slice of `EmailClient` we use (lets tests inject a fake). */
export interface AcsSender {
  beginSend(message: {
    senderAddress: string;
    recipients: { to: Array<{ address: string }> };
    content: { subject: string; plainText: string };
  }): Promise<{ pollUntilDone(): Promise<{ status?: string; error?: { message?: string } }> }>;
}

/**
 * Production transport: Azure Communication Services Email (ADR-0005), authenticated with the managed
 * identity (no connection string in config). Failures throw so callers (magic link, claim links) can surface
 * them; message bodies are never logged.
 */
export class AcsEmailTransport implements EmailTransport {
  constructor(
    private readonly sender: AcsSender,
    private readonly senderAddress: string,
  ) {}

  static fromEnv(env: { ACS_ENDPOINT: string; ACS_SENDER_ADDRESS: string }): AcsEmailTransport {
    return new AcsEmailTransport(
      new EmailClient(env.ACS_ENDPOINT, new DefaultAzureCredential()) as unknown as AcsSender,
      env.ACS_SENDER_ADDRESS,
    );
  }

  async send(msg: EmailMessage): Promise<void> {
    const poller = await this.sender.beginSend({
      senderAddress: this.senderAddress,
      recipients: { to: [{ address: msg.to }] },
      content: { subject: msg.subject, plainText: msg.text },
    });
    const result = await poller.pollUntilDone();
    if (result.status !== 'Succeeded') {
      throw new Error(`ACS email failed: ${result.status ?? 'unknown'}`);
    }
  }
}
