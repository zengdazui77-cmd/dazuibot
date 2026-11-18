import { createHmac, timingSafeEqual } from "node:crypto";

export interface CodeTaskDispatch {
  version: 1;
  jobId: string;
  capabilityToken: string;
  brokerUrl: string;
  model: string;
  taskId: string;
  teamId: string;
  projectId: string;
  repositoryUrl: string;
  defaultBranch: string;
  branch: string;
  instructions: string;
  createdBy: string;
  executorAttempts: number;
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function signature(secret: string, jobId: string, payload: unknown): string {
  return createHmac("sha256", secret).update(`${jobId}\n${stableJson(payload)}`, "utf8").digest("hex");
}

export function verifySignature(secret: string, jobId: string, payload: unknown, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = signature(secret, jobId, payload);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

export function capability(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : "";
}

export function validJobId(value: unknown): value is string {
  return typeof value === "string" && /^ct_[A-Za-z0-9_-]{16,160}$/.test(value);
}
