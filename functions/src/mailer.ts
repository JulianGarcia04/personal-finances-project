// Outgoing email over Gmail SMTP (nodemailer) with an app password stored as
// Functions secrets. Credentials are never logged.
import { defineSecret } from "firebase-functions/params";
import nodemailer from "nodemailer";

/** Gmail address used to authenticate (and default sender). */
export const SMTP_USER = defineSecret("SMTP_USER");
/** Gmail app password (https://myaccount.google.com/apppasswords), not the account password. */
export const SMTP_PASS = defineSecret("SMTP_PASS");

export interface SmtpConfig {
  user: string;
  pass: string;
  from: string;
}

export interface OutgoingEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export type SendEmail = (email: OutgoingEmail) => Promise<void>;

type TransportFactory = (options: { service: string; auth: { user: string; pass: string } }) => {
  sendMail(mail: Record<string, unknown>): Promise<unknown>;
};

/** Null when SMTP is not configured (emulator/dev): callers skip sending instead of failing. */
export function resolveSmtpConfig(values: { user?: string; pass?: string; from?: string }): SmtpConfig | null {
  const user = values.user?.trim() ?? "";
  const pass = values.pass?.trim() ?? "";
  if (!user || !pass) return null;
  const from = values.from?.trim() || `Vault <${user}>`;
  return { user, pass, from };
}

/** Reads the SMTP secrets and the optional ALERTS_FROM env var at call time. */
export function smtpConfigFromEnvironment(): SmtpConfig | null {
  return resolveSmtpConfig({ user: SMTP_USER.value(), pass: SMTP_PASS.value(), from: process.env.ALERTS_FROM });
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function uniqueRecipients(emails: Iterable<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const email of emails) {
    const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (EMAIL_PATTERN.test(normalized)) unique.add(normalized);
  }
  return [...unique];
}

export function createGmailSender(
  config: SmtpConfig,
  createTransport: TransportFactory = (options) => nodemailer.createTransport(options)
): SendEmail {
  const transport = createTransport({ service: "gmail", auth: { user: config.user, pass: config.pass } });
  return async ({ to, subject, html, text }) => {
    // Members are BCC-ed so no one sees the other recipients' addresses.
    await transport.sendMail({ from: config.from, to: config.from, bcc: to.join(", "), subject, html, text });
  };
}
