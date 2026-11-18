import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function encryptionKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error("TEAM_CREDENTIAL_SECRET must be at least 32 characters");
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptCredential(secret: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptCredential(secret: string, encoded: string): string {
  const [version, ivPart, tagPart, ciphertextPart, ...extra] = encoded.split(":");
  if (version !== "v1" || !ivPart || !tagPart || !ciphertextPart || extra.length) throw new Error("Invalid encrypted team credential");
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("Invalid encrypted team credential");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function credentialTail(value: string): string {
  return value.slice(-4);
}
