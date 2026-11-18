import nodemailer from "nodemailer";
import type { Config } from "./config.js";

export interface Mailer {
  sendCode(email: string, code: string): Promise<void>;
  sendInvitation(email: string, teamName: string, inviteUrl: string): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(private readonly config: Config) {
    if (!config.smtpUrl) throw new Error("TEAM_SMTP_URL is required to send email");
    this.transport = nodemailer.createTransport(config.smtpUrl, { disableFileAccess: true, disableUrlAccess: true });
  }

  sendCode(email: string, code: string): Promise<void> {
    return this.transport.sendMail({
      from: this.config.mailFrom,
      to: email,
      subject: "Your Dazuibot sign-in code",
      text: `Your sign-in code is ${code}. It expires in 10 minutes. If you did not request it, you can ignore this email.`,
    }).then(() => undefined);
  }

  sendInvitation(email: string, teamName: string, inviteUrl: string): Promise<void> {
    return this.transport.sendMail({
      from: this.config.mailFrom,
      to: email,
      subject: `Invitation to join ${teamName} on Dazuibot`,
      text: `You have been invited to join ${teamName} on Dazuibot. Open this one-time link within 7 days: ${inviteUrl}`,
    }).then(() => undefined);
  }
}
