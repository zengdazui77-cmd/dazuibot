import { describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { loadConfig } from "../src/config.js";

const productionEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgres://team:password@postgres:5432/team",
  TEAM_SESSION_SECRET: "session-secret-with-enough-randomness-0123456789",
  TEAM_CREDENTIAL_SECRET: "credential-secret-is-independent-0123456789",
  TEAM_HOST: "team.example.com",
  TEAM_PUBLIC_URL: "https://team.example.com",
  TEAM_SMTP_URL: "smtps://mailer:password@smtp.example.com:465",
  TEAM_MAIL_FROM: "Dazuibot Teams <noreply@team.example.com>",
});

describe("deployment configuration validation", () => {
  it("accepts a production origin and SMTP-over-TLS configuration", () => {
    const config = loadConfig(productionEnv());
    expect(config).toMatchObject({ production: true, publicUrl: "https://team.example.com", allowDevCodes: false });
  });

  it("requires TLS for production SMTP, including explicit STARTTLS for smtp URLs", () => {
    const env = productionEnv();
    env.TEAM_SMTP_URL = "smtp://mailer:password@smtp.example.com:587";
    expect(() => loadConfig(env)).toThrow(/requireTLS=true/);
    env.TEAM_SMTP_URL = "smtp://mailer:password@smtp.example.com:587?requireTLS=true";
    expect(() => loadConfig(env)).not.toThrow();
    const transport = nodemailer.createTransport(env.TEAM_SMTP_URL) as unknown as { transporter: { options: { requireTLS?: boolean; secure?: boolean } } };
    expect(transport.transporter.options).toMatchObject({ requireTLS: true, secure: false });
    env.TEAM_SMTP_URL = "smtp://mailer:password@smtp.example.com:587?requireTLS=true&ignoreTLS=true";
    expect(() => loadConfig(env)).toThrow(/must not ignore TLS/);
    env.TEAM_SMTP_URL = "smtps://mailer:password@smtp.example.com:465?tls.rejectUnauthorized=false";
    const insecureTransport = nodemailer.createTransport(env.TEAM_SMTP_URL) as unknown as { transporter: { options: { tls?: { rejectUnauthorized?: boolean } } } };
    expect(insecureTransport.transporter.options.tls?.rejectUnauthorized).toBe(false);
    expect(() => loadConfig(env)).toThrow(/verify the server TLS certificate/);
  });

  it("requires the public team hostname and URL origin to agree", () => {
    const env = productionEnv();
    env.TEAM_HOST = "other.example.com";
    expect(() => loadConfig(env)).toThrow(/must match/);
    env.TEAM_HOST = "team.-example.com";
    expect(() => loadConfig(env)).toThrow(/valid DNS hostname/);
    env.TEAM_HOST = "127.0.0.1";
    expect(() => loadConfig(env)).toThrow(/valid DNS hostname/);
    env.TEAM_HOST = "team.example.com";
    env.TEAM_PUBLIC_URL = "https://team.example.com/path";
    expect(() => loadConfig(env)).toThrow(/site origin/);
  });

  it("requires an explicit sender address for production sign-in and invitation mail", () => {
    const env = productionEnv();
    delete env.TEAM_MAIL_FROM;
    expect(() => loadConfig(env)).toThrow(/TEAM_MAIL_FROM/);
    env.TEAM_MAIL_FROM = "Dazuibot Teams <noreply@localhost>";
    expect(() => loadConfig(env)).toThrow(/non-local sender address/);
  });

  it("rejects reuse of session, credential, or executor secrets", () => {
    const env = productionEnv();
    env.TEAM_CREDENTIAL_SECRET = env.TEAM_SESSION_SECRET;
    expect(() => loadConfig(env)).toThrow(/different from TEAM_SESSION_SECRET/);
    env.TEAM_CREDENTIAL_SECRET = "credential-secret-is-independent-0123456789";
    env.TEAM_CODE_EXECUTOR_URL = "https://executor.example.com";
    env.TEAM_CODE_EXECUTOR_SECRET = env.TEAM_SESSION_SECRET;
    expect(() => loadConfig(env)).toThrow(/different from the session and credential/);
  });

  it("accepts private Kubernetes service origins for the in-cluster executor", () => {
    const env = productionEnv();
    env.TEAM_CODE_EXECUTOR_URL = "http://dazuibot-code-executor.dazuibot-tasks.svc.cluster.local:9888";
    env.TEAM_CODE_EXECUTOR_BROKER_URL = "http://team-api.dazuibot-team.svc.cluster.local:8787";
    env.TEAM_CODE_EXECUTOR_SECRET = "executor-secret-is-independent-0123456789";
    expect(loadConfig(env)).toMatchObject({
      codeExecutorUrl: "http://dazuibot-code-executor.dazuibot-tasks.svc.cluster.local:9888",
      codeExecutorBrokerUrl: "http://team-api.dazuibot-team.svc.cluster.local:8787",
    });
  });

  it("keeps the convenient shared-key fallback only in development and disables dev codes in production", () => {
    const dev = loadConfig({ DATABASE_URL: "postgres://unused", TEAM_SESSION_SECRET: "development-secret-long-enough-0123456789", TEAM_ALLOW_DEV_CODES: "true" });
    expect(dev.credentialSecret).toBe(dev.sessionSecret);
    expect(dev.allowDevCodes).toBe(true);
    const prod = productionEnv();
    prod.TEAM_ALLOW_DEV_CODES = "true";
    expect(loadConfig(prod).allowDevCodes).toBe(false);
  });
});
