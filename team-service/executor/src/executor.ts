import { KubernetesClient, kubeJobName, kubePayloadSecretName, safeTaskJob } from "./kubernetes.js";
import type { KubeJob } from "./kubernetes.js";
import type { ExecutorConfig } from "./config.js";
import { capability, signature, stableJson, validJobId, type CodeTaskDispatch } from "./protocol.js";

const RESULT_MARKER = "DAZUIBOT_RESULT:";
const ERROR_LIMIT = 3_000;
const RESULT_LIMIT = 19_000;

interface ActiveJob {
  payload: CodeTaskDispatch;
  sequence: number;
  lastHeartbeat: number;
}

export interface ExecutorOptions {
  fetch?: typeof fetch;
  now?: () => number;
  reportError?: (kind: string) => void;
}

export function validateDispatch(value: unknown, expectedBrokerUrl: string): CodeTaskDispatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid code task envelope");
  const payload = value as Partial<CodeTaskDispatch>;
  if (payload.version !== 1 || !validJobId(payload.jobId) || !capability(payload.capabilityToken) || payload.brokerUrl !== expectedBrokerUrl) throw new Error("Invalid code task envelope");
  if (typeof payload.model !== "string" || payload.model.length > 120) throw new Error("Invalid task model");
  if (typeof payload.taskId !== "string" || !/^[a-f0-9]{16,64}$/.test(payload.taskId)) throw new Error("Invalid task identifier");
  if (typeof payload.teamId !== "string" || typeof payload.projectId !== "string" || typeof payload.createdBy !== "string") throw new Error("Invalid task scope");
  if (payload.executorAttempts !== 1 && payload.executorAttempts !== 2 && payload.executorAttempts !== 3) throw new Error("Invalid task attempt");
  if (typeof payload.instructions !== "string" || payload.instructions.trim().length < 1 || payload.instructions.length > 20_000) throw new Error("Invalid task instructions");
  if (typeof payload.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(payload.branch) || payload.branch.includes("..") || payload.branch.includes("//")) throw new Error("Invalid task branch");
  if (typeof payload.defaultBranch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(payload.defaultBranch) || payload.defaultBranch.includes("..") || payload.defaultBranch.includes("//")) throw new Error("Invalid repository branch");
  if (typeof payload.repositoryUrl !== "string") throw new Error("Invalid repository URL");
  const repository = new URL(payload.repositoryUrl);
  if (repository.protocol !== "https:" || !["github.com", "gitlab.com"].includes(repository.hostname) || repository.username || repository.password || repository.search || repository.hash) throw new Error("Invalid repository URL");
  return payload as CodeTaskDispatch;
}

export class CodeTaskExecutor {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveJob>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly config: ExecutorConfig, private readonly kube: KubernetesClient, private readonly options: ExecutorOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    const jobs = await this.kube.listJobs();
    for (const job of jobs) {
      const jobId = job.metadata.labels?.["dazuibot.com/job-id"];
      if (!jobId || !validJobId(jobId)) continue;
      const envelope = await this.kube.getSecretEnvelope(kubePayloadSecretName(jobId));
      if (!envelope) continue;
      try {
        const payload = validateDispatch(JSON.parse(envelope), this.config.teamApiUrl);
        if (!this.kube.verifyStoredPayload(job, payload) || !safeTaskJob(job, payload, this.config)) {
          this.options.reportError?.("recovered_job_integrity_check_failed");
          await Promise.all([
            this.kube.deleteJob(job.metadata.name).catch(() => undefined),
            this.kube.deleteSecret(kubePayloadSecretName(jobId)).catch(() => undefined),
            this.kube.deleteNetworkPolicy(jobId).catch(() => undefined),
          ]);
          continue;
        }
        await this.kube.ensureTaskNetworkPolicy(payload);
        this.active.set(jobId, { payload, sequence: Number(job.metadata.annotations?.["dazuibot.com/heartbeat-sequence"] ?? 0), lastHeartbeat: 0 });
      } catch {
        this.options.reportError?.("invalid_recovered_job");
      }
    }
    this.timer = setInterval(() => { void this.tick(); }, 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async accept(raw: unknown): Promise<{ accepted: true; duplicate: boolean }> {
    const payload = validateDispatch(raw, this.config.teamApiUrl);
    const existing = await this.kube.getJob(kubeJobName(payload.jobId));
    if (existing) {
      const envelope = await this.kube.getSecretEnvelope(kubePayloadSecretName(payload.jobId));
      if (!envelope || stableJson(JSON.parse(envelope)) !== stableJson(payload) || !this.kube.verifyStoredPayload(existing, payload) || !safeTaskJob(existing, payload, this.config)) throw new Error("A different or unsafe payload already uses this task job id");
      await this.kube.ensureTaskNetworkPolicy(payload);
      this.active.set(payload.jobId, {
        payload,
        sequence: Number(existing.metadata.annotations?.["dazuibot.com/heartbeat-sequence"] ?? 0),
        lastHeartbeat: 0,
      });
      return { accepted: true, duplicate: true };
    }
    if (this.active.size >= 4) throw new Error("The code executor is at its active job limit");
    const existingEnvelope = await this.kube.getSecretEnvelope(kubePayloadSecretName(payload.jobId));
    if (existingEnvelope && stableJson(JSON.parse(existingEnvelope)) !== stableJson(payload)) throw new Error("A different payload already uses this task job id");
    if (!existingEnvelope) await this.kube.createSecret(payload);
    await this.kube.ensureTaskNetworkPolicy(payload);
    let job: KubeJob;
    try {
      job = (await this.kube.createJob(payload)).job;
    } catch (error) {
      // The create call can fail after Kubernetes stored the Job. Only a Job known to be absent is cleaned up,
      // and the dispatch is refused either way unless a verified Job exists: accepting without one would leave
      // the API waiting on a task nobody runs.
      const stored = await this.kube.getJob(kubeJobName(payload.jobId));
      if (!stored) {
        await this.kube.deleteSecret(kubePayloadSecretName(payload.jobId)).catch(() => undefined);
        await this.kube.deleteNetworkPolicy(payload.jobId).catch(() => undefined);
        throw error;
      }
      if (!this.kube.verifyStoredPayload(stored, payload) || !safeTaskJob(stored, payload, this.config)) throw error;
      job = stored;
    }
    this.active.set(payload.jobId, {
      payload,
      sequence: Number(job.metadata.annotations?.["dazuibot.com/heartbeat-sequence"] ?? 0),
      lastHeartbeat: 0,
    });
    return { accepted: true, duplicate: false };
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [jobId, job] of this.active) {
        try { await this.tickJob(jobId, job); }
        catch { this.options.reportError?.("executor_job_poll_failed"); }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickJob(jobId: string, active: ActiveJob): Promise<void> {
    const name = kubeJobName(jobId);
    const job = await this.kube.getJob(name);
    if (!job) {
      await this.finish(jobId, active, "failed", undefined, "sandbox_job_missing");
      return;
    }
    if (job.status?.succeeded) {
      const result = await this.readResult(job, active.payload);
      await this.finish(jobId, active, result?.outcome === "succeeded" ? "succeeded" : "failed", result?.result, result?.error ?? (result ? undefined : "sandbox_result_missing"));
      return;
    }
    if (job.status?.failed) {
      const result = await this.readResult(job, active.payload);
      const condition = job.status.conditions?.find((item) => item.type === "Failed");
      await this.finish(jobId, active, "failed", undefined, result?.error ?? condition?.reason ?? "sandbox_job_failed");
      return;
    }
    if (this.now() - active.lastHeartbeat < this.config.heartbeatMs) {
      if (job.spec && (job.spec as { suspend?: boolean }).suspend) await this.kube.resumeJob(name);
      return;
    }
    const sequence = active.sequence + 1;
    const body = { sequence, sentAt: this.now() };
    const response = await this.fetcher(`${this.config.apiUrl}/v1/internal/code-tasks/${encodeURIComponent(jobId)}/heartbeat`, {
      method: "POST",
      headers: this.executorHeaders(jobId, body),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`heartbeat rejected with HTTP ${response.status}`);
    const value = await response.json() as { state?: { status?: string; shouldStop?: boolean } };
    if (value.state?.shouldStop) {
      await this.kube.deleteJob(name).catch(() => undefined);
      await this.kube.deleteSecret(kubePayloadSecretName(jobId)).catch(() => undefined);
      await this.kube.deleteNetworkPolicy(jobId).catch(() => undefined);
      this.active.delete(jobId);
      return;
    }
    if (value.state?.status === "dispatching") {
      active.lastHeartbeat = this.now();
      return;
    }
    if (value.state?.status !== "running") throw new Error("heartbeat returned an unexpected executor state");
    await this.kube.updateHeartbeatSequence(name, sequence);
    active.sequence = sequence;
    active.lastHeartbeat = this.now();
    if (job.spec && (job.spec as { suspend?: boolean }).suspend) await this.kube.resumeJob(name);
  }

  private async readResult(job: KubeJob, payload: CodeTaskDispatch): Promise<{ outcome: "succeeded" | "failed"; result?: string; error?: string } | undefined> {
    const pods = await this.kube.podsForJob(job.metadata.name);
    const pod = pods.find((item) => item.status?.phase === "Succeeded") ?? pods[0];
    if (!pod) return undefined;
    const logs = await this.kube.podLogs(pod.metadata.name, this.config.maxOutputBytes);
    const line = logs.split(/\r?\n/).findLast((item) => item.startsWith(RESULT_MARKER));
    if (!line) return undefined;
    try {
      const value = JSON.parse(line.slice(RESULT_MARKER.length)) as { outcome?: unknown; branch?: unknown; summary?: unknown; diff?: unknown; diffTruncated?: unknown; error?: unknown };
      const token = payload.capabilityToken;
      const safe = (raw: unknown, max: number): string => (typeof raw === "string" ? raw : "").replaceAll(token, "[task capability redacted]").slice(0, max);
      if (value.outcome === "failed") return { outcome: "failed", error: safe(value.error, ERROR_LIMIT) || "sandbox task failed" };
      return { outcome: "succeeded", result: JSON.stringify({
        branch: safe(value.branch, 120), summary: safe(value.summary, 2_000), diff: safe(value.diff, 15_000), diffTruncated: value.diffTruncated === true,
      }).slice(0, RESULT_LIMIT) };
    } catch {
      return undefined;
    }
  }

  private async finish(jobId: string, active: ActiveJob, outcome: "succeeded" | "failed", result?: string, error?: string): Promise<void> {
    const body = { outcome, ...(result ? { result } : {}), ...(error ? { error: error.slice(0, ERROR_LIMIT) } : {}) };
    const response = await this.fetcher(`${this.config.apiUrl}/v1/internal/code-tasks/${encodeURIComponent(jobId)}/result`, {
      method: "POST",
      headers: this.executorHeaders(jobId, body),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && response.status !== 409) throw new Error(`result rejected with HTTP ${response.status}`);
    await this.kube.deleteSecret(kubePayloadSecretName(jobId)).catch(() => undefined);
    await this.kube.deleteNetworkPolicy(jobId).catch(() => undefined);
    this.active.delete(jobId);
    if (outcome === "failed") await this.kube.deleteJob(kubeJobName(jobId)).catch(() => undefined);
  }

  private executorHeaders(jobId: string, body: unknown): Headers {
    return new Headers({
      "content-type": "application/json",
      "x-executor-job-id": jobId,
      "x-executor-signature": signature(this.config.secret, jobId, body),
    });
  }
}
