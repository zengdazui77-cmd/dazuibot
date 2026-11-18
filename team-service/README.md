# Cloud team service prototype

中文首期试点部署顺序见 [`deploy/first-pilot-zh.md`](deploy/first-pilot-zh.md)。首期建议使用 Docker Compose，保持 `TEAM_CODE_EXECUTOR_URL` 为空，让成员先验证登录、邀请、共享聊天和 Git 协作。

This service is a backend foundation for the existing desktop App's team space. It implements email-code accounts, teams and roles, invitations, shared bot definitions, team/private conversations, shared messages, an encrypted model-key vault, a durable text-chat job queue, and a worker that calls an operator-configured OpenAI-compatible model gateway. The worker only handles text chat; it has no shell, code execution, repository, or channel tools. It also exposes a code-task approval and signed external-executor protocol. Without `TEAM_CODE_EXECUTOR_URL`, approved tasks stop at `approved_waiting_executor`; with it, the API only dispatches a bounded, credential-free envelope and accepts signed results from a separate executor. This is still a prototype and is not production-ready.

## Model access: two layers

Model access is decided in two layers, and a request must pass both.

**Baseline** — `team_model_policies`, one row per team. Decides *which models members may pick*:

- `all` — unrestricted
- `catalog` — only models registered in the deployment catalog
- `allowlist` — only the models the team selected

Members pick freely within that range, and each member's own choice is remembered.

**Overlay** — `team_model_policy_rules`, many rows per team. Decides *what else must hold*:

- blocked models (and an optional per-rule allowlist)
- requests per hour, per user and per team
- input/output tokens per request, and total tokens per user per day
- which roles a rule applies to

Rules combine with AND: hitting any one of them rejects the request. A rule whose role list is empty applies to every role. The overlay only ever produces a *rejection* — no rule hit means the request passes.

Rejections are recorded in `team_model_policy_violations` and can be read at `GET /v1/teams/:id/model-policy-violations`.

```
GET    /v1/teams/:id/model-policy-rules              list rules
POST   /v1/teams/:id/model-policy-rules              create
GET    /v1/teams/:id/model-policy-rules/:rid         read one
PUT    /v1/teams/:id/model-policy-rules/:rid         update
DELETE /v1/teams/:id/model-policy-rules/:rid         delete
PUT    /v1/teams/:id/model-policy-rules/enabled      enable/disable many
PUT    /v1/teams/:id/model-policy-rules/:rid/enabled enable/disable one
GET    /v1/teams/:id/model-policy-violations         rejection log
```

Creating, editing and deleting rules is restricted to owners and admins. Members can read the rules and the rejection log, because they need to know which constraints apply to them.

## Browser workspace

The service ships its own web interface. Start the service and open `http://127.0.0.1:<port>/` (also served at `/app` and `/web`) in a browser — no desktop App required. From there you can sign in with an email code, join or create a team, post in shared conversations, invite members, set the team's model permission scope, and read usage and audit records.

The page is inlined by `src/web-page.ts` and served with a strict content security policy: `default-src 'none'`, inline styles only, and scripts tagged with a per-response nonce. No external resources are loaded.

"发送验证码" and "登录" are two halves of one flow: the code is requested once and then used to sign in. The service enforces a 60-second cooldown per email address, so do not request a second code between those two clicks. In development mode (`TEAM_ALLOW_DEV_CODES=true` with no SMTP configured) the code is shown directly on the page.

## Local development

Requirements: Node.js 22.13 or newer and PostgreSQL 15 or newer.

```powershell
Copy-Item .env.example .env
npm ci
npm test
npm run build
npm run dev
```

For local testing without SMTP, set `TEAM_ALLOW_DEV_CODES=true` and `NODE_ENV=development` in `.env`. The API then returns the code in the response. Never enable this in a deployed environment.

## PostgreSQL integration test

The standard `npm test` suite uses PGlite for fast isolated tests. To verify behavior against a real PostgreSQL server, use one of these:

```sh
# 自动起一个一次性数据库，跑完自动清理（无需预装数据库）
npm run test:postgres:local

# 或者指向自己的一次性数据库
TEAM_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dzteam_test npm run test:postgres
```

`npm run test:postgres:local` prefers Docker (`postgres:16-alpine`) and falls back to `embedded-postgres`, which ships native PostgreSQL binaries and needs no system installation. On Windows, the Postgres executables must live under an ASCII-only path — a path containing non-ASCII characters makes `initdb` fail with `invalid byte sequence for encoding "UTF8"` — so the fallback installs into a temporary ASCII directory and uses `--locale=C` to avoid the GBK default locale.

Against a real server, three suites run:

- `test/events.postgres.integration.test.ts` opens two independent listener pools and a third publisher connection, then checks that notifications become visible only after the publishing transaction commits.
- `test/postgres.integration.test.ts` exercises migrations, the full HTTP flow (sign-in, team creation, model-key configuration, messaging), encrypted-at-rest key storage, foreign-key rejection, and `pg_advisory_xact_lock` on real PostgreSQL.
- `test/team-service.test.ts` runs the whole main business suite against real PostgreSQL instead of PGlite. Each test file uses its own schema (`dz_main_suite`, `dz_integration_suite`) so parallel runs cannot drop each other's tables.

Each suite drops and recreates only its own schema, so point `TEAM_TEST_DATABASE_URL` at a disposable database. The GitHub Actions workflow is configured to run it against PostgreSQL 17; its first run is still pending.

## Container deployment preview

For the first production pilot, run `./scripts/setup-pilot-env.sh` on the Linux server; it creates a restricted `.env`, generates independent database and session secrets, and leaves the executor disabled. The script does not start services or contact external systems. For manual setup, copy `.env.example` to `.env`, then set a real URL-safe `PG_PASSWORD`, a random `TEAM_SESSION_SECRET`, a different random `TEAM_CREDENTIAL_SECRET`, matching HTTPS `TEAM_PUBLIC_URL`/`TEAM_HOST`, a verified `TEAM_MAIL_FROM` address, and SMTP credentials using `smtps://` or `smtp://...?...requireTLS=true`. Production rejects reused session/credential secrets, plaintext SMTP, mismatched team hostnames, missing/local sender addresses, and public URLs with credentials or paths. If `TEAM_CODE_EXECUTOR_URL` is set, provide a third independent `TEAM_CODE_EXECUTOR_SECRET`. Set `TEAM_MODEL_BASE_URL` to the trusted model gateway used by this deployment. The endpoint is operator-controlled; team admins can choose a model and save a key but cannot redirect the service to an arbitrary URL. Keep `.env` private and out of source control. Back up `TEAM_CREDENTIAL_SECRET` separately from PostgreSQL; without it, saved model keys cannot be decrypted. The API binds to `127.0.0.1:8787` on the host; terminate TLS with the server's reverse proxy and route `TEAM_HOST` to that port. PostgreSQL is not published outside the Docker network. The API container uses a read-only root filesystem, drops Linux capabilities, denies privilege escalation, and has configurable CPU, memory and process limits (`TEAM_API_CPUS`, `TEAM_API_MEMORY_LIMIT`). Tune these starting defaults against the expected workload; `/readyz` health checks include PostgreSQL connectivity.

```sh
docker compose up --build -d
docker compose logs -f team-api
```

Create a restricted-permission database backup and checksum with `sh ./scripts/backup.sh ./backups`. Restore into a new database with `sh ./scripts/restore-to-new-db.sh --confirm ./backups/dazuibot-team-<timestamp>.dump team_restore_<date>`; this does not replace the current database and requires the matching checksum file. Point `DATABASE_URL` in `.env` at the new database only after validating the restore, confirm the matching `TEAM_CREDENTIAL_SECRET` is available, and restart `team-api`. Keep backup files and the encryption secret in separate, access-controlled off-host storage. Docker Engine is required; these scripts have shell syntax and argument validation, but a successful database restore still must be rehearsed in the deployment environment.

The service applies versioned SQL migrations at startup. Back up the `team-db` volume before upgrades and before any destructive maintenance. When a sign-in code is requested, the service removes authentication challenges older than 24 hours and expired sessions; this opportunistic cleanup runs as authentication traffic arrives. Worker jobs use a durable PostgreSQL queue, short leases, and at most three attempts for transient model errors. Each reply is stored as a shared assistant message; removing its author, changing their role to viewer, a member leaving, or rotating/deleting the team model key cancels affected queued/running jobs and prevents late replies from being committed. Those cancellation updates issue PostgreSQL notifications in the same transaction, so connected clients receive them only after the state commits. Expired leases that have exhausted retries are marked failed and notify connected clients. The HTTPS invitation page offers a `dazuibot://` link to open the installed desktop App and retains copy/paste as a fallback. The App fills the invite token but still requires the invited member to sign in and explicitly accept it.

Queue timing uses the database clock on both sides. `team_jobs.available_at` is written by the database default (`now()`) and compared against `clock_timestamp()` in the same session, so the two never disagree and a queued job is always claimable the moment it is inserted. Mixing clocks here is a real hazard: the App and the database run on different machines, the network round trip leaves the App clock roughly a millisecond behind the database clock, and PostgreSQL's `now()` carries microseconds while Node's `Date` carries only milliseconds. A job written and claimed in the same millisecond was then judged "not due yet" and never claimed — intermittently, about once every 6 to 15 attempts against a real PostgreSQL server. The same rule applies to `team_sessions.expires_at` and `team_invitations.expires_at`: those are written from the application clock and are compared against the application clock, never the database's `now()`. `test/postgres.integration.test.ts` covers the queue-timing case against a real server, including a simulated 50 ms cross-machine clock offset.

`deploy/nginx-team.conf` is a single-edge example for the Compose binding on `127.0.0.1:8787`. Install it as an Nginx HTTP-context site config, install `deploy/team-proxy-headers.conf` at `/etc/nginx/snippets/team-proxy-headers.conf`, replace the example hostname and certificate paths, and set the same public hostname in `.env`. It limits authentication requests by the source address Nginx sees, applies a general API limit, caps request bodies, and disables buffering for SSE. Its access log records the URI path without query strings, so invitation tokens are not written to the standard access log. If a CDN or load balancer sits in front, configure Nginx's trusted real-IP ranges before using these limits; never trust arbitrary client-supplied forwarding headers. Validate with `nginx -t` before reload.

The API can register GitHub/GitLab project URLs and list them for team members. Repository cloning, member-specific local branches, and uncommitted local diff previews stay on each member's computer. Owners/admins can save separate GitHub and GitLab fine-grained access tokens; the service encrypts them with `TEAM_CREDENTIAL_SECRET` and never returns them. Developers and admins can view a bounded remote diff for a pushed branch, then ask the service to create its PR/MR; the service records review creation in the team audit log. The service does not clone repositories, run code, or push branches. Limit each token to the registered repositories and the minimum pull/merge request permissions needed. Removing someone from the app team does not revoke that member's separate personal access to the Git host.

The model API key is encrypted with AES-256-GCM before it is stored. Only owners and admins may replace or delete it; the raw key is never returned by the API. Database backups contain ciphertext, so a tested restore must also have the matching credential secret. Configure HTTPS, mail delivery, monitoring, tested off-host backups and restores, and edge rate limits before inviting real users. Do not treat this compose scaffold as production certification.

## API outline

- `POST /v1/auth/codes` requests an email sign-in code.
- `POST /v1/auth/sessions` exchanges the code for a member session.
- `GET /v1/me` lists the signed-in member and teams.
- `/v1/teams` creates and lists teams.
- `DELETE /v1/teams/:teamId` permanently deletes a team and its cloud resources; only the owner may do this and must send the exact team name as `confirmName`. Member computers' local repository clones are not affected.
- `/v1/teams/:teamId/members` manages membership and roles.
- `DELETE /v1/teams/:teamId/members/me` lets the signed-in member leave; owners must first transfer ownership to another member. The departing member's queued/running jobs are cancelled, while shared team data remains.
- `GET /v1/teams/:teamId/audit` returns up to 100 recent audit events to owners and admins.
- `/v1/teams/:teamId/invitations` manages invites.
- `/v1/teams/:teamId/bots` lists and creates shared bot instructions.
- `/v1/teams/:teamId/conversations` lists and creates shared or creator-private conversations.
- `/v1/teams/:teamId/conversations/:conversationId/messages` reads history and queues a cloud text reply when a member posts.
- `GET /v1/teams/:teamId/conversations/:conversationId/events` streams content-free update notifications over SSE; it checks the caller's team and private-conversation access before subscribing, rechecks access before each notification and heartbeat, and closes the stream after access is revoked. PostgreSQL `LISTEN/NOTIFY` distributes notifications between service instances; clients must still fetch message content through the authenticated messages endpoint.
- `/v1/teams/:teamId/projects` lets owners/admins register a GitHub/GitLab repository and default branch; team members can list registered projects.
- `/v1/teams/:teamId/git-credentials` reports whether team GitHub/GitLab tokens are configured; owners/admins can replace or delete a provider token.
- `POST /v1/teams/:teamId/projects/:projectId/reviews` creates a GitHub PR or GitLab MR for an already-pushed source branch. Developers, owners, and admins can create reviews; viewers are read-only.
- `GET /v1/teams/:teamId/projects/:projectId/diff?head=...` reads a bounded GitHub/GitLab diff against the project's default branch; developers and admins can view it.
- `GET/POST /v1/teams/:teamId/projects/:projectId/code-tasks` lists or creates a code-task request. Developers can create tasks; requests start as `pending_approval`.
- `POST /v1/teams/:teamId/projects/:projectId/code-tasks/:taskId/approve|reject` records an Owner/Admin decision. Approval changes the task to `approved_waiting_executor`; an optional external dispatcher may then move it through `dispatching` and `running`, but the API process itself never executes code.
- `POST /v1/teams/:teamId/projects/:projectId/code-tasks/:taskId/cancel` lets the creator or Owner/Admin cancel an open request.
- `POST /v1/internal/code-tasks/:jobId/result` accepts only a signed callback from the configured external executor. See `deploy/code-executor-contract.md`; the API process never executes code.
- `POST /v1/internal/code-tasks/:jobId/heartbeat` accepts signed, timestamped, monotonic executor heartbeats, renews a 45-second running lease, and tells a cancelled/expired executor to stop. Running tasks without heartbeats become failed; they are not automatically re-executed.
- `/v1/teams/:teamId/usage` reports successful replies and token counts explicitly returned by the model gateway for the last 30 days; owners/admins see the team breakdown and other members see their own usage.
- `/v1/teams/:teamId/model-config` reads masked model settings; owners/admins can replace or delete the model key.
- `GET /v1/teams/:teamId/model-policy` reads the team's model access policy and the caller's own model choice. Owners/admins set the range with `PUT /v1/teams/:teamId/model-policy` (`mode` is `all`, `catalog`, or `allowlist`; `allowlist` requires `allowedModels`). Members pick their own model within that range with `PUT /v1/teams/:teamId/model-policy/model` (`model`, empty string clears the choice). Tightening the policy clears member choices that fall outside the new range. Teams without a policy row are unrestricted (`all`), and a policy row created without an explicit mode also defaults to `all`; `allowlist` always requires at least one model, so a team can never end up with no usable model.
- `POST /v1/invitations/accept` accepts an invitation after signing in with the invited email.

All authenticated endpoints require `Authorization: Bearer <member-session>`. Raw session tokens and invitation tokens are not stored in the database; only digests are stored.

Usage reporting is not billing: counts are limited to successful replies for which the gateway returned valid input and output token totals. Failed/retried upstream requests may have separate provider-side charges and are not estimated by this service.
