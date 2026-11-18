# Isolated code executor contract

The team API is the control plane. It does not run a shell, mount a repository, open a Docker socket, or read a member's Git credential. An executor is a separate service deployed with its own sandbox boundary.

## Dispatch

When `TEAM_CODE_EXECUTOR_URL` and `TEAM_CODE_EXECUTOR_SECRET` are configured, the API dispatcher claims an approved task and sends:

```text
POST {TEAM_CODE_EXECUTOR_URL}/v1/code-tasks
X-Executor-Job-Id: ct_<opaque id>
X-Executor-Signature: HMAC-SHA256(secret, job-id + "\n" + stable-json(body))
```

The body contains `version`, `jobId`, a random task-scoped capability, a private broker URL, the configured model identifier, `taskId`, `teamId`, `projectId`, repository URL, default branch, target branch, instructions, creator id, and the dispatch attempt. It contains no model key, Git token, session token, or local path. The capability is encrypted at rest and cleared when the task reaches a terminal state. A `2xx` response means the executor accepted the job; it does not mean that code completed. The executor must treat `jobId` as an idempotency key because the API can re-send the same job after a dispatch lease expires.

## Task-scoped broker

The executor controller creates a fresh Job and passes the capability only to that Job. The Job may use the capability in `X-Executor-Capability` (or `Authorization: Bearer <capability>`) for these API endpoints:

```text
GET  /v1/internal/code-tasks/{jobId}/snapshot
POST /v1/internal/code-tasks/{jobId}/model/chat/completions
POST /v1/internal/code-tasks/{jobId}/heartbeat
POST /v1/internal/code-tasks/{jobId}/result
```

The snapshot endpoint fetches a bounded archive of the registered repository's default branch using the encrypted team Git credential on the API side. It never returns the credential or follows an untrusted host redirect. The model endpoint checks the task lease, member role, model configuration and a per-task request budget, then forwards the request with the encrypted team model key on the API side. It bounds request and response size and does not allow the task to select another model or endpoint. Capability requests are rejected after cancellation, lease expiry, member revocation or a terminal result. The controller, rather than the Job, uses the shared executor secret for signed heartbeats and result callbacks; the Job never receives that shared secret.

## Runtime lease and cancellation

After accepting the dispatch, the API marks the task `running` with a 45-second execution lease. The executor must heartbeat every 15 seconds (or sooner) and persist its per-job sequence across restarts. Use a strictly increasing integer sequence beginning at 1 and a Unix timestamp in milliseconds:

```text
POST /v1/internal/code-tasks/{jobId}/heartbeat
X-Executor-Job-Id: ct_<opaque id>
X-Executor-Signature: HMAC-SHA256(secret, job-id + "\n" + stable-json(body))
Content-Type: application/json

{"sequence": 1, "sentAt": 1794318828000}
```

`sentAt` must be within 30 seconds of the API clock. A repeated or older sequence does not extend the lease. A valid response is `{ "state": { "status": "running", "shouldStop": false, "leaseExpiresAt": "..." } }`. If the task was cancelled, failed, completed, or its lease expired, the API returns `shouldStop: true`; the executor must immediately terminate the sandbox and must not push or publish its results. A running lease that expires is marked failed, with no automatic re-execution. Dispatch retry remains limited to delivery before acceptance and always reuses the same job id.

## Callback

The executor posts a bounded result to:

```text
POST /v1/internal/code-tasks/{jobId}/result
X-Executor-Job-Id: ct_<opaque id>
X-Executor-Signature: HMAC-SHA256(secret, job-id + "\n" + stable-json(body))
```

The body is `{ "outcome": "succeeded" | "failed", "result": ..., "error": ... }`. The API verifies the job id and signature, accepts callbacks only for a running job, bounds result and error text, and treats cancelled or already terminal jobs idempotently.

## Required executor boundary

The executor implementation is a separate deployment responsibility. The checked-in Kubernetes controller creates a fresh per-job Job and NetworkPolicy. It must use a non-root runner with no host mounts or Docker socket, CPU/memory/process/time/output limits, network egress limited to the private team API and cluster DNS, a dedicated service identity, and a digest-pinned runner image. Repository credentials are used only by the API to produce the read-only archive; they are not mounted in the runner. The runner has no shared executor secret, member Git token or team model key. The API's `running`, `succeeded`, and `failed` states only describe this external contract; they are not evidence that a cluster, CNI NetworkPolicy enforcement, image signature policy, or DSH runtime has been deployed.
