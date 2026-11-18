import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CodeTaskExecutor } from "./executor.js";
import { verifySignature, validJobId } from "./protocol.js";

const BODY_LIMIT = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += part.byteLength;
    if (length > BODY_LIMIT) throw new HttpError(413, "Task envelope is too large");
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Task envelope must be JSON"); }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createExecutorHttpServer(executor: CodeTaskExecutor, secret: string) {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://executor.local");
      if (req.method === "GET" && url.pathname === "/healthz") { send(res, 200, { ok: true }); return; }
      if (req.method !== "POST" || url.pathname !== "/v1/code-tasks") { send(res, 404, { error: "Not found" }); return; }
      if (!req.headers["content-type"]?.toString().toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
      const payload = await readJson(req);
      const jobId = typeof payload === "object" && payload !== null && "jobId" in payload ? String((payload as { jobId: unknown }).jobId) : "";
      const suppliedJobId = typeof req.headers["x-executor-job-id"] === "string" ? req.headers["x-executor-job-id"] : "";
      const signature = typeof req.headers["x-executor-signature"] === "string" ? req.headers["x-executor-signature"] : "";
      if (!validJobId(jobId) || suppliedJobId !== jobId || !verifySignature(secret, jobId, payload, signature)) throw new HttpError(401, "Invalid executor task signature");
      const result = await executor.accept(payload);
      send(res, 202, result);
    })().catch((error: unknown) => {
      const known = error instanceof HttpError;
      const status = known ? error.status : 503;
      if (!known) console.error("executor request failed", { method: req.method, path: new URL(req.url ?? "/", "http://executor.local").pathname, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      if (!res.headersSent) send(res, status, { error: known ? error.message : "Executor is temporarily unavailable" });
      else res.destroy();
    });
  });
}
