import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const id = (): string => randomBytes(16).toString("hex");
export const secret = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const emailCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const codeDigest = (key: string, challengeId: string, email: string, code: string): string =>
  createHmac("sha256", key).update(`${challengeId}\n${email}\n${code}`).digest("hex");

export function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

export function bearer(req: { headers: Record<string, string | string[] | undefined> }): string {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header);
  return match?.[1] ?? "";
}
