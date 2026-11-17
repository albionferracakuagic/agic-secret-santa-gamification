export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Production transport = Azure Communication Services Email (ADR-0005), added with infra. */
export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

/** Local dev only: prints the message (incl. magic link) to the server console. Refuses to run in production. */
export class ConsoleEmailTransport implements EmailTransport {
  constructor() {
    if (process.env['NODE_ENV'] === 'production')
      throw new Error('ConsoleEmailTransport must not be used in production');
  }
  async send(msg: EmailMessage): Promise<void> {
    console.log(`[email] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
  }
}

export class MemoryEmailTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
  }
}
