import { describe, expect, it } from "vitest";
import { buildTaskJob, buildTaskNetworkPolicy, buildTaskSecret, kubeJobName, safeTaskJob } from "../src/kubernetes.js";
import { validateTarListing, validateTarVerboseListing } from "../src/archive.js";
import { loadConfig } from "../src/config.js";
import { CodeTaskExecutor, validateDispatch } from "../src/executor.js";
import { KubernetesClient, type KubernetesClient as KubernetesClientType, type KubeJob } from "../src/kubernetes.js";
import { verifySignature } from "../src/protocol.js";

const payload = {
  version: 1 as const,
  jobId: "ct_0123456789abcdef",
  capabilityToken: "capability-token-that-is-at-least-32-characters-long",
  brokerUrl: "https://team.example.test",
  model: "team-model",
  taskId: "0123456789abcdef0123456789abcdef",
  teamId: "team-1",
  projectId: "project-1",
  repositoryUrl: "https://github.com/acme/repo",
  defaultBranch: "main",
  branch: "feature/task",
  instructions: "Run the repository checks and report the bounded diff.",
  createdBy: "user-1",
  executorAttempts: 1,
};

const config = loadConfig({
  TEAM_API_URL: "https://team.example.test",
  TEAM_CODE_EXECUTOR_SECRET: "executor-secret-that-is-at-least-32-characters",
  EXECUTOR_RUNNER_IMAGE: `registry.example.test/dazuibot-runner@sha256:${"a".repeat(64)}`,
  NODE_ENV: "production",
});

describe("isolated team code executor manifests", () => {
  it("requires a pinned non-root job with no service-account token or host mounts", () => {
    const job = buildTaskJob(payload, config) as any;
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.suspend).toBe(true);
    expect(job.spec.activeDeadlineSeconds).toBe(1200);
    expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(job.spec.template.spec.hostNetwork).not.toBe(true);
    expect(job.spec.template.spec.containers[0].securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } });
    expect(job.spec.template.spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 65532 });
    // emptyDir 属主是 root:root 0755，runner 以 65532 跑进去写不了 ——
    // 没有 fsGroup 时 git init 报 Permission denied，代码任务必然失败。
    expect(job.spec.template.spec.securityContext).toMatchObject({ fsGroup: 65532 });
    expect(job.spec.template.spec.volumes.map((item: any) => item.hostPath)).not.toContain(expect.anything());
    expect(JSON.stringify(job)).not.toContain("modelKey");
    expect(JSON.stringify(job)).not.toContain("gitToken");
  });

  it("allows only the API and cluster DNS from the task network policy", () => {
    const policy = buildTaskNetworkPolicy(payload, config) as any;
    expect(policy.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.spec.ingress).toEqual([]);
    expect(policy.spec.egress).toHaveLength(2);
    expect(policy.spec.egress[0].ports).toEqual([{ protocol: "TCP", port: 8787 }]);
    expect(policy.spec.egress[1].ports).toEqual([{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }]);
    expect(policy.spec.egress[0].to[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe("dazuibot-team");
    expect(JSON.stringify(policy)).not.toContain("0.0.0.0/0");
  });

  it("uses a task secret only for the signed envelope", () => {
    const secret = buildTaskSecret(payload, config) as any;
    expect(secret.type).toBe("Opaque");
    expect(secret.stringData.envelope).toContain(payload.capabilityToken);
    expect(secret.stringData.envelope).not.toContain("apiKey");
    expect(kubeJobName(payload.jobId)).toBe("dazuibot-0123456789abcdef");
  });

  it("rejects a stored Job whose runner command or environment was changed", () => {
    const job = buildTaskJob(payload, config);
    const stored = structuredClone(job) as any;
    stored.metadata.uid = "job-controller-uid";
    stored.spec.selector = { matchLabels: {
      "batch.kubernetes.io/controller-uid": "job-controller-uid",
      "batch.kubernetes.io/job-name": kubeJobName(payload.jobId),
    } };
    stored.spec.suspend = false;
    stored.spec.template.spec.serviceAccountName = "default";
    stored.spec.template.spec.containers[0].terminationMessagePath = "/dev/termination-log";
    stored.spec.template.spec.containers[0].terminationMessagePolicy = "File";
    expect(safeTaskJob(stored, payload, config)).toBe(true);
    const changed = structuredClone(stored) as any;
    changed.spec.template.spec.containers[0].command = ["sh", "-c", "unexpected command"];
    expect(safeTaskJob(changed, payload, config)).toBe(false);
    const extraEnv = structuredClone(stored) as any;
    extraEnv.spec.template.spec.containers[0].env.push({ name: "UNEXPECTED", value: "exfiltration-target" });
    expect(safeTaskJob(extraEnv, payload, config)).toBe(false);
    const changedSelector = structuredClone(stored) as any;
    changedSelector.spec.selector = { matchLabels: { "job-name": "other-job" } };
    expect(safeTaskJob(changedSelector, payload, config)).toBe(false);
  });
});

describe("executor input validation", () => {
  it("rejects a task envelope for a different control origin", () => {
    expect(() => validateDispatch({ ...payload, brokerUrl: "https://evil.example.test" }, config.teamApiUrl)).toThrow();
    expect(validateDispatch(payload, config.teamApiUrl).model).toBe("team-model");
  });

  it("rejects traversal paths in an archive listing", () => {
    expect(() => validateTarListing("repo/ok/file.js\nrepo/../secret\n")).toThrow("unsafe path");
    expect(() => validateTarListing("repo/src/index.js\nrepo/package.json\n")).not.toThrow();
    expect(() => validateTarVerboseListing("-rw-r--r-- 0/0 3 2026-01-01 00:00 repo/a.txt\ndrwxr-xr-x 0/0 0 2026-01-01 00:00 repo/src/")).not.toThrow();
    expect(() => validateTarVerboseListing("lrwxrwxrwx 0/0 0 2026-01-01 00:00 repo/link -> /etc")).toThrow("only regular files");
  });

  it("accepts a real GitHub tarball listing (顶层目录条目 + 文件)", () => {
    // GitHub 的 tarball 清单长这样：顶层目录条目以 / 结尾，去掉首段后是空串。
    // 之前把它判成不安全路径，导致所有真实仓库快照在解包前就被拒绝。
    expect(() => validateTarListing("Hello-World-master/\nHello-World-master/README\n")).not.toThrow();
    expect(() => validateTarListing("repo-abc123/\nrepo-abc123/src/\nrepo-abc123/src/index.js\n")).not.toThrow();
  });

  it("rejects entries that straddle multiple root directories", () => {
    expect(() => validateTarListing("repo-a/file.txt\nrepo-b/file.txt\n")).toThrow("multiple root directories");
  });
});

describe("task network policy idempotency", () => {
  it("rejects a pre-existing policy that is broader than the expected API and DNS rules", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = new KubernetesClient(config, async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname });
      if (method === "POST") return new Response("already exists", { status: 409 });
      return Response.json({
        metadata: { name: `${kubeJobName(payload.jobId)}-egress`, namespace: config.namespace },
        spec: { podSelector: { matchLabels: {} }, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }] },
      });
    });

    await expect(client.ensureTaskNetworkPolicy(payload)).rejects.toThrow("unexpected or unverifiable configuration");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });
});

describe("task executor lifecycle", () => {
  it("refuses a dispatch whose sandbox Job could not be created and cleans up its secret and policy", async () => {
    const deleted: string[] = [];
    const kube = {
      getJob: async () => undefined,
      getSecretEnvelope: async () => undefined,
      createSecret: async () => undefined,
      ensureTaskNetworkPolicy: async () => undefined,
      createJob: async () => { throw new Error("Kubernetes could not create task job (HTTP 403)"); },
      deleteSecret: async () => { deleted.push("secret"); },
      deleteNetworkPolicy: async () => { deleted.push("policy"); },
    } as unknown as KubernetesClientType;
    const executor = new CodeTaskExecutor(config, kube);
    await expect(executor.accept(payload)).rejects.toThrow("HTTP 403");
    expect(deleted).toEqual(["secret", "policy"]);
  });

  it("accepts idempotently, heartbeats the API, and reports a bounded result", async () => {
    let job: KubeJob | undefined;
    let secret: string | undefined;
    let policy = false;
    let sequence = 0;
    const calls: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
    const kube = {
      listJobs: async () => [],
      getJob: async () => job,
      getSecretEnvelope: async () => secret,
      verifyStoredPayload: () => true,
      createSecret: async (value: typeof payload) => { secret = JSON.stringify(value); },
      createNetworkPolicy: async () => { policy = true; },
      ensureTaskNetworkPolicy: async () => { policy = true; },
      createJob: async (value: typeof payload) => {
        job = buildTaskJob(value, config);
        job.metadata.uid = "job-controller-uid";
        (job.spec as any).selector = { matchLabels: {
          "batch.kubernetes.io/controller-uid": "job-controller-uid",
          "batch.kubernetes.io/job-name": kubeJobName(value.jobId),
        } };
        return { created: true, job };
      },
      updateHeartbeatSequence: async (_name: string, next: number) => { sequence = next; },
      resumeJob: async () => { if (job?.spec) (job.spec as Record<string, unknown>).suspend = false; },
      podsForJob: async () => [{ metadata: { name: "task-pod" }, status: { phase: "Succeeded" } }],
      podLogs: async () => `DAZUIBOT_RESULT:${JSON.stringify({ outcome: "succeeded", branch: payload.branch, summary: "task completed", diff: "+safe\n" })}`,
      deleteSecret: async () => { secret = undefined; },
      deleteNetworkPolicy: async () => { policy = false; },
      deleteJob: async () => { job = undefined; },
    } as unknown as KubernetesClientType;
    const executor = new CodeTaskExecutor(config, kube, {
      now: () => 1_800_000_000_000,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        calls.push({ path: url.pathname, body, headers });
        if (url.pathname.endsWith("/heartbeat")) return Response.json({ state: { status: "running", shouldStop: false } });
        return Response.json({ ok: true });
      },
    });

    expect(await executor.accept(payload)).toEqual({ accepted: true, duplicate: false });
    expect(policy).toBe(true);
    expect(await executor.accept(payload)).toEqual({ accepted: true, duplicate: true });
    await executor.tick();
    expect(sequence).toBe(1);
    expect((job!.spec as any).suspend).toBe(false);
    expect(calls[0]?.path).toBe(`/v1/internal/code-tasks/${payload.jobId}/heartbeat`);
    expect(verifySignature(config.secret, payload.jobId, calls[0]?.body, calls[0]?.headers.get("x-executor-signature") ?? "")).toBe(true);

    job!.status = { succeeded: 1 };
    await executor.tick();
    expect(calls[1]?.path).toBe(`/v1/internal/code-tasks/${payload.jobId}/result`);
    expect(calls[1]?.body).toMatchObject({ outcome: "succeeded" });
    expect(String(calls[1]?.body.result)).toContain("task completed");
    expect(verifySignature(config.secret, payload.jobId, calls[1]?.body, calls[1]?.headers.get("x-executor-signature") ?? "")).toBe(true);
    expect(policy).toBe(false);
  });
});
