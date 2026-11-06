import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";

export * from "./templates";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export type EmailConfig =
  | { provider: "smtp"; from: string; host: string; port: number }
  | { provider: "ses"; from: string; region: string }
  | { provider: "memory"; from: string };

/** SMTP: Mailpit in development. Never used for real mail in tests. */
export class SmtpEmailSender implements EmailSender {
  private readonly transport;

  constructor(
    private readonly config: { from: string; host: string; port: number },
  ) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: false,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.from, ...message });
  }
}

/** AWS SES v2 for production (D-06). Credentials come from the instance role / environment. */
export class SesEmailSender implements EmailSender {
  private readonly client: SESv2Client;

  constructor(private readonly config: { from: string; region: string }) {
    this.client = new SESv2Client({ region: config.region });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.config.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: message.html, Charset: "UTF-8" },
              Text: { Data: message.text, Charset: "UTF-8" },
            },
          },
        },
      }),
    );
  }
}

/** Keeps messages in memory. Tests read `sent`; nothing leaves the process. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** The most recent message to `to`, if any. */
  lastTo(to: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

export function createEmailSender(config: EmailConfig): EmailSender {
  switch (config.provider) {
    case "smtp":
      return new SmtpEmailSender(config);
    case "ses":
      return new SesEmailSender(config);
    case "memory":
      return new MemoryEmailSender();
  }
}
