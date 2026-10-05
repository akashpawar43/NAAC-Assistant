import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import type { Logger } from "./logger.js";

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** SMTP when configured (any free provider works), otherwise writes the mail to the log for local dev. */
export function createMailer(cfg: Config, logger: Logger, nodeEnv = process.env.NODE_ENV): Mailer {
  if (!cfg.smtp.host) {
    // The log fallback writes working sign-in links; in production anyone reading the logs could
    // then sign in as any user. Refuse to start instead.
    if (nodeEnv === "production") throw new Error("SMTP_HOST must be set in production: without it sign-in links would be written to the log");
    logger.warn("SMTP_HOST is not set: emails (including sign-in links) are written to this log instead of sent");
    return {
      async send(to, subject, text) {
        logger.info({ to, subject }, `[dev mail]\n${text}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from: cfg.smtp.from, to, subject, text });
      logger.info({ subject }, "email sent");
    },
  };
}

/** Collects mail in memory (tests). */
export class MemoryMailer implements Mailer {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) {
    this.sent.push({ to, subject, text });
  }
}
