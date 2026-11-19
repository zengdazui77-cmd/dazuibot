import { request as httpsRequest } from "node:https";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExecutorConfig } from "./config.js";
import { stableJson, type CodeTaskDispatch } from "./protocol.js";

const RESPONSE_LIMIT = 2 * 1024 * 1024;

export interface KubeJob {
  [key: string]: unknown;
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string>; [key: string]: unknown };
  status?: { active?: number; succeeded?: number; failed?: number; conditions?: Array<{ type?: string; reason?: string; message?: string }> };
}

interface KubePod { metadata: { name: string; labels?: Record<string, string> }; status?: { phase?: string } }

export function kubeJobName(jobId: string): string {
  return `dazuibot-${jobId.replace(/^ct_/, "")}`;
}

export function kubePayloadSecretName(jobId: string): string {
  return `${kubeJobName(jobId)}-payload`;
}

export function buildTaskSecret(payload: CodeTaskDispatch, namespace: string): Record<string, unknown> {
  const name = kubePayloadSecretName(payload.jobId);
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "dazuibot-code-executor", "dazuibot.com/task-job": kubeJobName(payload.jobId) } },
    type: "Opaque",
    stringData: { envelope: JSON.stringify(payload) },
  };
}

export function buildTaskJob(payload: CodeTaskDispatch, config: ExecutorConfig): KubeJob {
  const name = kubeJobName(payload.jobId);
  const labels = {
    "app.kubernetes.io/name": "dazuibot-code-task",
    "app.kubernetes.io/managed-by": "dazuibot-code-executor",
    "dazuibot.com/job-id": payload.jobId,
  };
  const secretName = kubePayloadSecretName(payload.jobId);
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: config.namespace,
      labels,
      annotations: {
        "dazuibot.com/payload-sha256": payloadHash(payload),
        "dazuibot.com/heartbeat-sequence": "0",
        "dazuibot.com/executor-signature": createHmac("sha256", config.secret).update(`${payload.jobId}\n${stablePayload(payload)}`, "utf8").digest("hex"),
      },
    },
    spec: {
      suspend: true,
      backoffLimit: 0,
      activeDeadlineSeconds: config.maxRuntimeSeconds,
      ttlSecondsAfterFinished: 600,
      completions: 1,
      parallelism: 1,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            // emptyDir 挂载出来的目录默认属主是 root:root、权限 0755，
            // runner 以 65532 身份跑进去就写不了 —— 表现为 `git init` 报
            // "/workspace/.git: Permission denied"，随后 `git config` 报
            // "fatal: not in a git directory"。fsGroup 让 k8s 把这些卷的
            // 属组改成 runAsGroup 并置位组写权限，runner 才建得出 .git。
            fsGroup: 65532,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [{
            name: "runner",
            image: config.runnerImage,
            imagePullPolicy: "IfNotPresent",
            command: ["node", "/opt/dazuibot-executor/run-task.mjs"],
            env: [{ name: "TEAM_TASK_ENVELOPE", valueFrom: { secretKeyRef: { name: secretName, key: "envelope" } } }],
            resources: {
              requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "512Mi" },
              limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "2Gi" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [
              { name: "workspace", mountPath: "/workspace" },
              { name: "home", mountPath: "/home/runner" },
              { name: "tmp", mountPath: "/tmp" },
            ],
          }],
          volumes: [
            { name: "workspace", emptyDir: { sizeLimit: "2Gi" } },
            { name: "home", emptyDir: { sizeLimit: "256Mi" } },
            { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
          ],
        },
      },
    },
  };
}

export function buildTaskNetworkPolicy(payload: CodeTaskDispatch, config: ExecutorConfig): Record<string, unknown> {
  const jobName = kubeJobName(payload.jobId);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: `${jobName}-egress`, namespace: config.namespace, labels: { "app.kubernetes.io/managed-by": "dazuibot-code-executor", "dazuibot.com/job-id": jobName } },
    spec: {
      podSelector: { matchLabels: { "job-name": jobName } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": config.apiNamespace } }, podSelector: { matchLabels: { "app.kubernetes.io/name": "dazuibot-team-api" } } }], ports: [{ protocol: "TCP", port: 8787 }] },
        { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
      ],
    },
  };
}

export function safeTaskJob(job: KubeJob, payload: CodeTaskDispatch, config: ExecutorConfig): boolean {
  const expected = buildTaskJob(payload, config);
  const spec = job.spec as Record<string, any> | undefined;
  const pod = spec?.template?.spec as Record<string, any> | undefined;
  const container = pod?.containers?.[0] as Record<string, any> | undefined;
  const expectedSpec = expected.spec as Record<string, any>;
  const expectedPod = expectedSpec.template.spec as Record<string, any>;
  const expectedContainer = expectedPod.containers[0] as Record<string, any>;
  if (!spec || !pod || !container || pod.containers.length !== 1) return false;

  // Kubernetes adds these harmless container defaults when it stores a Job.
  const comparableContainer = { ...container };
  for (const [key, value] of Object.entries({ terminationMessagePath: "/dev/termination-log", terminationMessagePolicy: "File" })) {
    if (comparableContainer[key] !== undefined && comparableContainer[key] !== value) return false;
    delete comparableContainer[key];
  }

  const expectedLabels = expected.metadata.labels ?? {};
  const podLabels = spec.template.metadata?.labels ?? {};
  const selector = spec.selector as { matchLabels?: Record<string, string>; matchExpressions?: unknown[] } | undefined;
  const selectorLabels = selector?.matchLabels;
  const jobUid = typeof job.metadata.uid === "string" ? job.metadata.uid : undefined;
  const selectorJobNames = [selectorLabels?.["batch.kubernetes.io/job-name"], selectorLabels?.["job-name"]].filter((value): value is string => value !== undefined);
  const selectorControllerUids = [selectorLabels?.["batch.kubernetes.io/controller-uid"], selectorLabels?.["controller-uid"]].filter((value): value is string => value !== undefined);
  const selectorSafe = selector !== undefined && (
    (!selector.matchExpressions || selector.matchExpressions.length === 0)
    && (jobUid ? selectorControllerUids.length > 0 && selectorControllerUids.every((value) => value === jobUid) : selectorJobNames.length > 0)
    && selectorJobNames.every((value) => value === expected.metadata.name)
    && selectorControllerUids.every((value) => !jobUid || value === jobUid)
    && Object.keys(selectorLabels ?? {}).every((key) => ["job-name", "controller-uid", "batch.kubernetes.io/job-name", "batch.kubernetes.io/controller-uid"].includes(key))
  );
  const templateSpecSafe = stableJson(comparableContainer) === stableJson(expectedContainer)
    && stableJson(pod.securityContext) === stableJson(expectedPod.securityContext)
    && stableJson(pod.volumes) === stableJson(expectedPod.volumes)
    && pod.restartPolicy === expectedPod.restartPolicy
    && pod.automountServiceAccountToken === false
    && pod.enableServiceLinks === false
    && (pod.serviceAccountName === undefined || pod.serviceAccountName === "default")
    && pod.hostNetwork !== true && pod.hostPID !== true && pod.hostIPC !== true
    && pod.shareProcessNamespace !== true
    && (!pod.initContainers || pod.initContainers.length === 0)
    && (!pod.imagePullSecrets || pod.imagePullSecrets.length === 0)
    && Object.entries(expectedLabels).every(([key, value]) => podLabels[key] === value);

  return job.metadata.name === expected.metadata.name
    && job.metadata.namespace === config.namespace
    && Object.entries(expectedLabels).every(([key, value]) => job.metadata.labels?.[key] === value)
    && spec.backoffLimit === 0
    && spec.activeDeadlineSeconds === config.maxRuntimeSeconds
    && spec.ttlSecondsAfterFinished === expectedSpec.ttlSecondsAfterFinished
    && spec.completions === 1 && spec.parallelism === 1
    && selectorSafe
    && (spec.suspend === true || spec.suspend === false)
    && spec.podFailurePolicy === undefined
    && spec.backoffLimitPerIndex === undefined
    && templateSpecSafe;
}

function thisImage(value: unknown, expected: string): boolean { return value === expected; }

function payloadHash(payload: CodeTaskDispatch): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function stablePayload(payload: CodeTaskDispatch): string {
  return JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))));
}

export class KubernetesClient {
  private readonly base: URL;

  constructor(private readonly config: ExecutorConfig, private readonly fetcher?: typeof fetch) {
    this.base = new URL(config.kubeApiUrl);
  }

  verifyStoredPayload(job: KubeJob, payload: CodeTaskDispatch): boolean {
    const supplied = job.metadata.annotations?.["dazuibot.com/executor-signature"] ?? "";
    if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
    const expected = createHmac("sha256", this.config.secret).update(`${payload.jobId}\n${stablePayload(payload)}`, "utf8").digest();
    const candidate = Buffer.from(supplied, "hex");
    return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
  }

  private path(suffix: string): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}${suffix}`;
  }

  private batchPath(suffix: string): string {
    return `/apis/batch/v1/namespaces/${encodeURIComponent(this.config.namespace)}${suffix}`;
  }

  private networkingPath(suffix: string): string {
    return `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(this.config.namespace)}${suffix}`;
  }

  private async request(path: string, method = "GET", payload?: unknown, contentType = "application/json"): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
    if (this.fetcher) {
      const headers = new Headers({ accept: "application/json" });
      if (payload !== undefined) headers.set("content-type", contentType);
      return this.fetchRequest(path, method, payload, headers);
    }
    const [token, ca] = await Promise.all([readFile(this.config.kubeTokenPath, "utf8"), readFile(this.config.kubeCaPath)]);
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token.trim()}`, accept: "application/json" };
      const body = payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload);
      if (body !== undefined) { headers["content-type"] = contentType; headers["content-length"] = String(Buffer.byteLength(body)); }
      const request = httpsRequest(new URL(path, this.base), { method, ca, headers, rejectUnauthorized: true }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > RESPONSE_LIMIT) { request.destroy(new Error("Kubernetes API response exceeded the limit")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({
          status: response.statusCode ?? 500,
          headers: new Headers(Object.entries(response.headers).flatMap(([key, value]) => value == null ? [] : [[key, Array.isArray(value) ? value.join(",") : String(value)]])),
          bytes: Buffer.concat(chunks, length),
        }));
        response.on("error", reject);
      });
      request.setTimeout(15_000, () => request.destroy(new Error("Kubernetes API request timed out")));
      request.on("error", reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  private async fetchRequest(path: string, method: string, payload: unknown, headers: Headers): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
    const token = await readFile(this.config.kubeTokenPath, "utf8").catch(() => "test-token");
    headers.set("authorization", `Bearer ${token.trim()}`);
    const response = await this.fetcher!(new URL(path, this.base), {
      method,
      headers,
      ...(payload === undefined ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > RESPONSE_LIMIT) throw new Error("Kubernetes API response exceeded the limit");
    return { status: response.status, headers: response.headers, bytes };
  }

  private async json<T>(path: string, method = "GET", payload?: unknown, contentType = "application/json"): Promise<{ status: number; value?: T; text: string }> {
    const response = await this.request(path, method, payload, contentType);
    const text = new TextDecoder().decode(response.bytes);
    let value: T | undefined;
    try { value = text ? JSON.parse(text) as T : undefined; } catch { /* upstream error body handled by status */ }
    return { status: response.status, value, text };
  }

  async getJob(name: string): Promise<KubeJob | undefined> {
    const result = await this.json<KubeJob>(this.batchPath(`/jobs/${encodeURIComponent(name)}`));
    if (result.status === 404) return undefined;
    if (result.status < 200 || result.status >= 300 || !result.value) throw new Error(`Kubernetes could not read job ${name} (HTTP ${result.status})`);
    return result.value;
  }

  async listJobs(): Promise<KubeJob[]> {
    const result = await this.json<{ items?: KubeJob[] }>(this.batchPath("/jobs?labelSelector=app.kubernetes.io%2Fmanaged-by%3Ddazuibot-code-executor"));
    if (result.status < 200 || result.status >= 300) throw new Error(`Kubernetes could not list executor jobs (HTTP ${result.status})`);
    return result.value?.items ?? [];
  }

  async createSecret(payload: CodeTaskDispatch): Promise<void> {
    const result = await this.json(this.path("/secrets"), "POST", buildTaskSecret(payload, this.config.namespace));
    if (result.status !== 409 && (result.status < 200 || result.status >= 300)) throw new Error(`Kubernetes could not create task secret (HTTP ${result.status})`);
  }

  async createNetworkPolicy(payload: CodeTaskDispatch): Promise<void> {
    const result = await this.json(this.networkingPath("/networkpolicies"), "POST", buildTaskNetworkPolicy(payload, this.config));
    if (result.status >= 200 && result.status < 300) return;
    if (result.status !== 409) throw new Error(`Kubernetes could not create task egress policy (HTTP ${result.status})`);
    const expected = buildTaskNetworkPolicy(payload, this.config) as { metadata: { name: string; namespace: string }; spec: unknown };
    const existing = await this.json<{ metadata?: { name?: string; namespace?: string }; spec?: unknown }>(this.networkingPath(`/networkpolicies/${encodeURIComponent(expected.metadata.name)}`));
    if (existing.status !== 200 || !existing.value
      || existing.value.metadata?.name !== expected.metadata.name
      || existing.value.metadata?.namespace !== expected.metadata.namespace
      || stableJson(existing.value.spec) !== stableJson(expected.spec)) {
      throw new Error("Kubernetes task egress policy already exists with an unexpected or unverifiable configuration");
    }
  }

  async ensureTaskNetworkPolicy(payload: CodeTaskDispatch): Promise<void> {
    await this.createNetworkPolicy(payload);
  }

  async deleteNetworkPolicy(jobId: string): Promise<void> {
    const result = await this.json(this.networkingPath(`/networkpolicies/${encodeURIComponent(`${kubeJobName(jobId)}-egress`)}`), "DELETE", { apiVersion: "v1", kind: "DeleteOptions" });
    if (result.status !== 404 && (result.status < 200 || result.status >= 300)) throw new Error(`Kubernetes could not delete task egress policy (HTTP ${result.status})`);
  }

  async getSecretEnvelope(name: string): Promise<string | undefined> {
    const result = await this.json<{ data?: { envelope?: string } }>(this.path(`/secrets/${encodeURIComponent(name)}`));
    if (result.status === 404) return undefined;
    if (result.status < 200 || result.status >= 300) throw new Error(`Kubernetes could not read task secret ${name} (HTTP ${result.status})`);
    const encoded = result.value?.data?.envelope;
    return encoded ? Buffer.from(encoded, "base64").toString("utf8") : undefined;
  }

  async createJob(payload: CodeTaskDispatch): Promise<{ created: boolean; job: KubeJob }> {
    const manifest = buildTaskJob(payload, this.config);
    const result = await this.json<KubeJob>(this.batchPath("/jobs"), "POST", manifest);
    if (result.status >= 200 && result.status < 300 && result.value) return { created: true, job: result.value };
    if (result.status === 409) {
      const existing = await this.getJob(manifest.metadata.name);
      if (existing && this.verifyStoredPayload(existing, payload)
        && existing.metadata.annotations?.["dazuibot.com/payload-sha256"] === manifest.metadata.annotations?.["dazuibot.com/payload-sha256"]
        && safeTaskJob(existing, payload, this.config)) return { created: false, job: existing };
      throw new Error("Kubernetes rejected a duplicate task job with a different payload");
    }
    throw new Error(`Kubernetes could not create task job (HTTP ${result.status})`);
  }

  async updateHeartbeatSequence(jobName: string, sequence: number): Promise<void> {
    const patch = { metadata: { annotations: { "dazuibot.com/heartbeat-sequence": String(sequence) } } };
    const result = await this.json(this.batchPath(`/jobs/${encodeURIComponent(jobName)}`), "PATCH", patch, "application/merge-patch+json");
    if (result.status < 200 || result.status >= 300) throw new Error(`Kubernetes could not persist task heartbeat sequence (HTTP ${result.status})`);
  }

  async resumeJob(jobName: string): Promise<void> {
    const patch = { spec: { suspend: false } };
    const result = await this.json(this.batchPath(`/jobs/${encodeURIComponent(jobName)}`), "PATCH", patch, "application/merge-patch+json");
    if (result.status < 200 || result.status >= 300) throw new Error(`Kubernetes could not start task job (HTTP ${result.status})`);
  }

  async podsForJob(jobName: string): Promise<KubePod[]> {
    const selector = new URLSearchParams({ labelSelector: `job-name=${jobName}` }).toString();
    const result = await this.json<{ items?: KubePod[] }>(this.path(`/pods?${selector}`));
    if (result.status < 200 || result.status >= 300) throw new Error(`Kubernetes could not list task pods (HTTP ${result.status})`);
    return result.value?.items ?? [];
  }

  async podLogs(podName: string, limit: number): Promise<string> {
    const path = this.path(`/pods/${encodeURIComponent(podName)}/log?container=runner&limitBytes=${limit}`);
    const result = await this.request(path);
    if (result.status < 200 || result.status >= 300) throw new Error(`Kubernetes could not read task logs (HTTP ${result.status})`);
    return new TextDecoder().decode(result.bytes);
  }

  async deleteJob(name: string): Promise<void> {
    const result = await this.json(this.batchPath(`/jobs/${encodeURIComponent(name)}`), "DELETE", { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background" });
    if (result.status !== 404 && (result.status < 200 || result.status >= 300)) throw new Error(`Kubernetes could not stop task job ${name} (HTTP ${result.status})`);
  }

  async deleteSecret(name: string): Promise<void> {
    const result = await this.json(this.path(`/secrets/${encodeURIComponent(name)}`), "DELETE", { apiVersion: "v1", kind: "DeleteOptions" });
    if (result.status !== 404 && (result.status < 200 || result.status >= 300)) throw new Error(`Kubernetes could not delete task secret ${name} (HTTP ${result.status})`);
  }
}
