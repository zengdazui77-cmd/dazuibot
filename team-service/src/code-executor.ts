import { createHmac } from "node:crypto";
import type { Config } from "./config.js";
import { safeEqualHex } from "./crypto.js";
import type { CodeTaskDispatch } from "./model.js";
import { TeamService } from "./service.js";

const DISPATCH_TIMEOUT_MS = 15_000;
const MAX_ERROR_BYTES = 4_000;

export interface CodeTaskExecutorPayload extends CodeTaskDispatch {
  version: 1;
}

export interface CodeTaskExecutorResult {
  outcome: "succeeded" | "failed";
  result?: unknown;
  error?: unknown;
}

export interface CodeTaskDispatcherOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function executorSignature(secret: string, jobId: string, payload: unknown): string {
  return createHmac("sha256", secret).update(`${jobId}\n${stableJson(payload)}`, "utf8").digest("hex");
}

export function verifyExecutorSignature(secret: string, jobId: string, payload: unknown, signature: string): boolean {
  return safeEqualHex(executorSignature(secret, jobId, payload), signature);
}

export class CodeTaskDispatcher {
  private active = false;
  private stopped = false;
  /** 打断当前轮询等待用；stop() 会调用它，避免关闭被轮询间隔拖住。 */
  private wake: (() => void) | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: Config, private readonly service: TeamService, options: CodeTaskDispatcherOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return Boolean(this.config.codeExecutorUrl && this.config.codeExecutorSecret);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.stopped = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async runOnce(): Promise<boolean> {
    const expired = await this.service.expireCodeTaskLeases();
    if (!this.enabled) return expired > 0;
    const dispatch = await this.service.claimCodeTaskForExecutor();
    if (!dispatch) return false;
    const payload: CodeTaskExecutorPayload = { version: 1, ...dispatch };
    try {
      const response = await this.fetcher(`${this.config.codeExecutorUrl}/v1/code-tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-executor-job-id": dispatch.jobId,
          "x-executor-signature": executorSignature(this.config.codeExecutorSecret, dispatch.jobId, payload),
        },
        body: stableJson(payload),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`executor returned HTTP ${response.status}`);
      await this.service.markCodeTaskDispatchAccepted(dispatch.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, MAX_ERROR_BYTES) : "executor dispatch failed";
      await this.service.markCodeTaskDispatchFailed(dispatch.jobId, message);
    }
    return true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const worked = await this.runOnce();
        if (!worked) await this.sleep(this.enabled ? this.config.codeExecutorPollMs : Math.max(this.config.codeExecutorPollMs, 5_000));
      } catch {
        await this.sleep(this.enabled ? this.config.codeExecutorPollMs : Math.max(this.config.codeExecutorPollMs, 5_000));
      }
    }
    this.active = false;
  }

  /** 可被 stop() 立刻打断的等待：不然关闭时会被整段轮询间隔拖住。 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
    });
  }

  /** Kept as a clock dependency for deterministic lifecycle tests. */
  currentTime(): number { return this.now(); }
}
