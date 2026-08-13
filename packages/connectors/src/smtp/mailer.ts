import nodemailer from "nodemailer";

/**
 * Real SMTP delivery via nodemailer (pure JS, no native deps). Credentials
 * live in this config object only — the CLI builds it from env inside the
 * child server process, so they never appear in tool args or the journal.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (port 465). STARTTLS on 587 works with secure: false. */
  secure: boolean;
  user?: string;
  pass?: string;
  /** The From: address for every outbound message. */
  from: string;
}

export interface OutboundMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type DeliverFn = (mail: OutboundMail) => Promise<{ messageId?: string }>;

export function createSmtpDeliver(config: SmtpConfig): DeliverFn {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user !== undefined
      ? { auth: { user: config.user, pass: config.pass ?? "" } }
      : {}),
  });
  return async (mail) => {
    const info = await transport.sendMail(mail);
    return { messageId: info.messageId };
  };
}
