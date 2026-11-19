import { randomBytes } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { Config } from "./config.js";
import { codeDigest, digest, emailCode, id, normalizeEmail, safeEqualHex, secret } from "./crypto.js";
import { HttpError } from "./model.js";
import type { CodeTaskDispatch, Invitation, Member, Principal, Team, TeamAuditEvent, TeamBot, TeamCodeTask, TeamCodeTaskStatus, TeamConversation, TeamJob, TeamMessage, TeamModelPolicyMode, TeamModelPolicyRule, TeamModelPolicyViolation, TeamProject, TeamRole, TeamUsage, TeamUsageMember, User } from "./model.js";
import { credentialTail, decryptCredential, encryptCredential } from "./credentials.js";
import { dedupeModels, isModelPermitted, normalizeModelId, permittedModels, resolveMemberModel } from "./model-policy.js";
import type { Mailer } from "./mailer.js";
import { Store } from "./store.js";

const CHALLENGE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;
const EXECUTOR_RUNNING_LEASE_MS = 45_000;
const EXECUTOR_HEARTBEAT_WINDOW_MS = 30_000;
const CODE_TASK_SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
const CODE_TASK_MODEL_REQUEST_MAX_BYTES = 1_000_000;
const CODE_TASK_MODEL_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
const CODE_TASK_MODEL_TIMEOUT_MS = 90_000;
const CODE_TASK_MODEL_MAX_TOKENS = 8_192;
const ROLES = new Set<TeamRole>(["owner", "admin", "developer", "viewer"]);

interface ChallengeRow extends QueryResultRow {
  id: string;
  email: string;
  code_digest: string;
  expires_at: Date | string;
  attempts: number;
  consumed_at: Date | string | null;
  created_at: Date | string;
}

interface MembershipRow extends QueryResultRow {
  team_id: string;
  team_name: string;
  role: TeamRole;
  created_at: Date | string;
}

interface InvitationRow extends QueryResultRow {
  id: string;
  team_id: string;
  team_name?: string;
  email: string;
  role: Exclude<TeamRole, "owner">;
  token_digest: string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

interface TeamBotRow extends QueryResultRow {
  id: string; team_id: string; name: string; description: string; instructions: string;
  created_by: string; created_at: Date | string; updated_at: Date | string;
}

interface ConversationRow extends QueryResultRow {
  id: string; team_id: string; bot_id: string; bot_name: string; title: string; visibility: "team" | "private";
  created_by: string; created_at: Date | string; updated_at: Date | string;
}

interface MessageRow extends QueryResultRow {
  id: string; conversation_id: string; author_user_id: string | null; author_email: string; role: "user" | "assistant"; content: string; created_at: Date | string;
}

interface JobRow extends QueryResultRow {
  id: string; conversation_id: string; status: TeamJob["status"]; attempt_count: number; error_code: string | null;
  created_at: Date | string; updated_at: Date | string;
}

interface UsageRow extends QueryResultRow {
  user_id: string;
  email: string;
  successful_jobs: string;
  reported_jobs: string;
  input_tokens: string;
  output_tokens: string;
}

interface ProjectRow extends QueryResultRow {
  id: string; team_id: string; name: string; provider: TeamProject["provider"]; repository_url: string; clone_url: string;
  default_branch: string; created_by: string; created_at: Date | string;
}

interface CodeTaskRow extends QueryResultRow {
  id: string; team_id: string; project_id: string; created_by: string; branch: string; instructions: string;
  status: TeamCodeTaskStatus; decision_reason: string | null; decided_by: string | null; decided_at: Date | string | null;
  executor_job_id: string | null; executor_attempts: number; executor_lease_until?: Date | string | null; executor_heartbeat_seq?: number | string; executor_started_at: Date | string | null; executor_finished_at: Date | string | null;
  executor_capability_hash?: string | null; executor_capability_encrypted?: string | null; executor_model_requests?: number;
  executor_result: string | null; executor_error: string | null;
  created_at: Date | string; updated_at: Date | string;
}

interface AuditRow extends QueryResultRow {
  id: string; actor_email: string | null; action: string; target_type: string; target_id: string; details: Record<string, unknown>; created_at: Date | string;
}

export interface PostTeamMessageResult {
  message: TeamMessage;
  job: TeamJob;
}

function normalizeRepositoryUrl(raw: unknown): { provider: TeamProject["provider"]; repositoryUrl: string; cloneUrl: string } {
  if (typeof raw !== "string") throw new HttpError(400, "Enter a valid GitHub or GitLab repository URL");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new HttpError(400, "Enter a valid GitHub or GitLab repository URL"); }
  const host = url.hostname.toLowerCase();
  const provider = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : undefined;
  if (!provider || url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, "Repository URLs must use HTTPS on github.com or gitlab.com without embedded credentials");
  }
  let repoPath = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  const segments = repoPath.split("/").filter(Boolean);
  if (segments.length < 2 || (provider === "github" && segments.length !== 2) || segments.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || part === "." || part === "..")) {
    throw new HttpError(400, "Repository URL must point to a GitHub or GitLab project");
  }
  repoPath = `/${segments.map((part) => part.toLowerCase()).join("/")}`;
  return { provider, repositoryUrl: `https://${host}${repoPath}`, cloneUrl: `https://${host}${repoPath}.git` };
}

function normalizeBranch(raw: unknown): string {
  const branch = typeof raw === "string" ? raw.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) {
    throw new HttpError(400, "Enter a valid Git branch name");
  }
  return branch;
}

async function readBoundedText(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - length;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
        length += Math.max(0, remaining);
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, length).toString("utf8"), truncated };
}

export interface ChallengeResult {
  expiresInSeconds: number;
  developmentCode?: string;
}

export interface SessionResult {
  token: string;
  expiresAt: string;
  user: User;
}

export interface CreateInvitationResult {
  invitation: Invitation;
  emailSent: boolean;
}

export interface TeamModelConfig {
  configured: boolean;
  modelBaseUrl?: string;
  model?: string;
  keyTail?: string;
}

/** 团队模型授权模式：创建者决定成员可选模型的范围 */
export type { TeamModelPolicyMode } from "./model.js";

export interface TeamModelPolicy {
  mode: TeamModelPolicyMode;
  /** mode=allowlist 时生效：被授权的模型列表 */
  allowedModels: string[];
  /** mode=catalog 时生效：部署侧登记的可用模型目录 */
  catalogModels: string[];
  /** 当前用户实际可用的模型（已按模式与成员偏好求交集） */
  availableModels: string[];
  /** 当前用户的成员级模型偏好；空串表示跟随团队默认 */
  memberModel?: string;
  updatedAt?: string;
}

export interface TeamModelCatalogEntry {
  model: string;
  available: boolean;
}

/** team_model_policy_rules 表的一行 */
interface PolicyRuleRow {
  id: string;
  team_id: string;
  rule_name: string;
  enabled: boolean;
  allowed_models: string[] | null;
  blocked_models: string[] | null;
  max_requests_per_user_per_hour: number | null;
  max_requests_per_team_per_hour: number | null;
  max_input_tokens_per_request: number | null;
  max_output_tokens_per_request: number | null;
  max_total_tokens_per_user_per_day: string | null;
  applies_to_roles: string[] | null;
  priority: number;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface GitCredentialStatus {
  github: { configured: boolean; keyTail?: string };
  gitlab: { configured: boolean; keyTail?: string };
}

export interface TeamReview {
  url: string;
  number?: number;
  title: string;
  state?: string;
}

export interface TeamProjectDiff {
  head: string;
  base: string;
  diff: string;
  truncated: boolean;
}

export interface CodeTaskSnapshot {
  archive: Uint8Array;
  contentType: string;
}

async function boundedBytes(response: Response, limit: number, message: string): Promise<Uint8Array> {
  const advertised = Number(response.headers.get("content-length") ?? 0);
  if (advertised > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, message);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, message);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export class TeamService {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly mailer?: Mailer,
    private readonly options: { now?: () => number; makeCode?: () => string; makeSecret?: (n?: number) => string; fetch?: typeof fetch } = {},
  ) { this.fetcher = options.fetch ?? fetch; }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private makeCode(): string { return this.options.makeCode?.() ?? emailCode(); }
  private makeSecret(bytes = 32): string { return this.options.makeSecret?.(bytes) ?? secret(bytes); }

  async requestLoginCode(rawEmail: unknown): Promise<ChallengeResult> {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new HttpError(400, "Enter a valid email address");
    if (!this.mailer && !this.config.allowDevCodes) throw new HttpError(503, "Email delivery is not configured");

    const now = this.now();
    const challengeId = id();
    const code = this.makeCode();
    const expiresAt = new Date(now + CHALLENGE_TTL_MS);
    await this.store.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dazuibot-login-code:${email}`]);
      await client.query("DELETE FROM team_email_challenges WHERE created_at < $1::timestamptz - interval '24 hours'", [new Date(now)]);
      await client.query("DELETE FROM team_sessions WHERE expires_at <= $1", [new Date(now)]);
      const limits = await client.query<{ count: string; newest: Date | string | null }>(
        `SELECT count(*)::text AS count, max(created_at) AS newest
           FROM team_email_challenges
          WHERE email = $1 AND created_at > $2::timestamptz - interval '1 hour'`,
        [email, new Date(now)],
      );
      const row = limits.rows[0];
      if (Number(row?.count ?? 0) >= 5) throw new HttpError(429, "Too many sign-in codes requested; try again later");
      if (row?.newest && new Date(row.newest).getTime() > now - 60_000) throw new HttpError(429, "Wait before requesting another sign-in code");
      await client.query("UPDATE team_email_challenges SET consumed_at = $2 WHERE email = $1 AND consumed_at IS NULL", [email, new Date(now)]);
      await client.query(
        "INSERT INTO team_email_challenges(id, email, code_digest, expires_at, created_at) VALUES($1, $2, $3, $4, $5)",
        [challengeId, email, codeDigest(this.config.sessionSecret, challengeId, email, code), expiresAt, new Date(now)],
      );
    });

    if (this.mailer) {
      try {
        await this.mailer.sendCode(email, code);
      } catch {
        await this.store.pool.query("UPDATE team_email_challenges SET consumed_at = $2 WHERE id = $1", [challengeId, new Date(this.now())]);
        throw new HttpError(502, "Could not send the sign-in email; try again later");
      }
    }
    return { expiresInSeconds: CHALLENGE_TTL_MS / 1000, ...(this.config.allowDevCodes && !this.mailer ? { developmentCode: code } : {}) };
  }

  async createSession(rawEmail: unknown, rawCode: unknown): Promise<SessionResult> {
    const email = normalizeEmail(rawEmail);
    const code = typeof rawCode === "string" ? rawCode.trim() : "";
    if (!email || !/^\d{6}$/.test(code)) throw new HttpError(401, "Invalid or expired sign-in code");
    const token = this.makeSecret(32);
    const expiresAt = new Date(this.now() + SESSION_TTL_MS);
    const user = await this.store.transaction(async (client) => {
      const selected = await client.query<ChallengeRow>(
        `SELECT * FROM team_email_challenges
          WHERE email = $1 AND consumed_at IS NULL
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [email],
      );
      const challenge = selected.rows[0];
      if (!challenge) return undefined;
      const now = this.now();
      const storedDigest = String(challenge.code_digest);
      const suppliedDigest = codeDigest(this.config.sessionSecret, challenge.id, email, code);
      const valid = new Date(challenge.expires_at).getTime() > now && Number(challenge.attempts) < 8 && safeEqualHex(storedDigest, suppliedDigest);
      if (!valid) {
        const attempts = Number(challenge.attempts) + 1;
        await client.query("UPDATE team_email_challenges SET attempts = $2, consumed_at = CASE WHEN $2 >= 8 OR expires_at <= $3 THEN $3 ELSE consumed_at END WHERE id = $1", [challenge.id, attempts, new Date(now)]);
        return undefined;
      }
      await client.query("UPDATE team_email_challenges SET consumed_at = $2 WHERE id = $1", [challenge.id, new Date(now)]);
      const result = await client.query<{ id: string; email: string; created_at: Date | string }>(
        `INSERT INTO team_users(id, email, email_verified_at, created_at)
         VALUES($1, $2, $3, $3)
         ON CONFLICT(email) DO UPDATE SET email_verified_at = EXCLUDED.email_verified_at
         RETURNING id, email, created_at`, [id(), email, new Date(now)],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Could not create the user");
      await client.query("INSERT INTO team_sessions(token_digest, user_id, expires_at, created_at) VALUES($1, $2, $3, $4)", [digest(token), row.id, expiresAt, new Date(now)]);
      return this.toUser(row);
    });
    if (!user) throw new HttpError(401, "Invalid or expired sign-in code");
    return { token, expiresAt: expiresAt.toISOString(), user };
  }

  async authenticate(token: string): Promise<Principal> {
    if (!token) throw new HttpError(401, "Sign in to continue");
    // expires_at 是用应用时钟写入的，比较也要用同一个时钟（不能用数据库的 now()）。
    const result = await this.store.pool.query<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM team_sessions s JOIN team_users u ON u.id = s.user_id
        WHERE s.token_digest = $1 AND s.expires_at > $2`, [digest(token), new Date(this.now())],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(401, "Sign-in session expired");
    // $3 必须显式转成 timestamptz：否则 $3 - interval 会被解析成「参数减区间」，
    // 结果类型是 interval，比较时报 "operator does not exist: timestamp with time zone < interval"。
    void this.store.pool.query("UPDATE team_sessions SET last_seen_at = $2 WHERE token_digest = $1 AND last_seen_at < ($3::timestamptz - interval '5 minutes')",
      [digest(token), new Date(this.now()), new Date(this.now())]).catch(() => undefined);
    return { userId: row.id, email: row.email };
  }

  async revokeSession(token: string): Promise<void> {
    if (token) await this.store.pool.query("DELETE FROM team_sessions WHERE token_digest = $1", [digest(token)]);
  }

  async createTeam(principal: Principal, rawName: unknown): Promise<Team> {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name.length < 1 || name.length > 80) throw new HttpError(400, "Team name must be between 1 and 80 characters");
    const teamId = id();
    const now = new Date(this.now());
    return this.store.transaction(async (client) => {
      const result = await client.query<{ id: string; name: string; created_at: Date | string }>(
        "INSERT INTO teams(id, name, created_by, created_at) VALUES($1, $2, $3, $4) RETURNING id, name, created_at", [teamId, name, principal.userId, now],
      );
      await client.query("INSERT INTO team_memberships(team_id, user_id, role, joined_at) VALUES($1, $2, 'owner', $3)", [teamId, principal.userId, now]);
      await this.audit(client, teamId, principal.userId, "team.created", "team", teamId, { name });
      return { id: teamId, name, role: "owner", createdAt: this.iso(result.rows[0]?.created_at ?? now) };
    });
  }

  async deleteTeam(principal: Principal, teamId: string, rawConfirmation: unknown): Promise<void> {
    const confirmation = typeof rawConfirmation === "string" ? rawConfirmation : "";
    await this.store.transaction(async (client) => {
      const selected = await client.query<{ name: string; role: TeamRole }>(
        `SELECT t.name, m.role FROM teams t JOIN team_memberships m ON m.team_id=t.id
          WHERE t.id=$1 AND m.user_id=$2 FOR UPDATE OF t, m`, [teamId, principal.userId],
      );
      const team = selected.rows[0];
      if (!team) throw new HttpError(404, "Team not found");
      if (team.role !== "owner") throw new HttpError(403, "Only the team owner can delete this team");
      if (confirmation !== team.name) throw new HttpError(409, "Team name confirmation does not match");
      const conversations = await client.query<{ id: string }>("SELECT id FROM team_conversations WHERE team_id=$1", [teamId]);
      await this.notifyConversations(client, conversations.rows.map((row) => row.id));
      await client.query("DELETE FROM teams WHERE id=$1", [teamId]);
    });
  }

  async listTeams(principal: Principal): Promise<Team[]> {
    const result = await this.store.pool.query<MembershipRow>(
      `SELECT t.id AS team_id, t.name AS team_name, m.role, t.created_at
         FROM team_memberships m JOIN teams t ON t.id = m.team_id
        WHERE m.user_id = $1 ORDER BY m.joined_at, t.id`, [principal.userId],
    );
    return result.rows.map((row) => ({ id: row.team_id, name: row.team_name, role: row.role, createdAt: this.iso(row.created_at) }));
  }

  async listMembers(principal: Principal, teamId: string): Promise<Member[]> {
    await this.requireMembership(principal, teamId);
    const result = await this.store.pool.query<{ user_id: string; email: string; role: TeamRole; joined_at: Date | string }>(
      `SELECT u.id AS user_id, u.email, m.role, m.joined_at
         FROM team_memberships m JOIN team_users u ON u.id = m.user_id
        WHERE m.team_id = $1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`, [teamId],
    );
    return result.rows.map((row) => ({ userId: row.user_id, email: row.email, role: row.role, joinedAt: this.iso(row.joined_at) }));
  }

  async listAuditEvents(principal: Principal, teamId: string): Promise<TeamAuditEvent[]> {
    await this.requireRole(principal, teamId, new Set(["owner", "admin"]));
    const result = await this.store.pool.query<AuditRow>(
      `SELECT e.id, u.email AS actor_email, e.action, e.target_type, e.target_id, e.details, e.created_at
         FROM team_audit_events e LEFT JOIN team_users u ON u.id=e.actor_user_id
        WHERE e.team_id=$1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100`, [teamId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      actorEmail: row.actor_email,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details : {},
      createdAt: this.iso(row.created_at),
    }));
  }

  async listInvitations(principal: Principal, teamId: string): Promise<Invitation[]> {
    await this.requireRole(principal, teamId, new Set(["owner", "admin"]));
    const result = await this.store.pool.query<InvitationRow>(
      `SELECT id, team_id, email, role, expires_at, created_at FROM team_invitations
        WHERE team_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
        ORDER BY created_at DESC`, [teamId, new Date(this.now())],
    );
    return result.rows.map((row) => this.toInvitation(row));
  }

  async createInvitation(principal: Principal, teamId: string, rawEmail: unknown, rawRole: unknown): Promise<CreateInvitationResult> {
    const email = normalizeEmail(rawEmail);
    const role = rawRole as Exclude<TeamRole, "owner">;
    if (!email) throw new HttpError(400, "Enter a valid email address");
    if (!(role === "admin" || role === "developer" || role === "viewer")) throw new HttpError(400, "Choose a valid member role");
    const invitationId = id();
    const token = this.makeSecret(32);
    const now = this.now();
    const expiresAt = new Date(now + INVITATION_TTL_MS);
    const inviteUrl = `${this.config.publicUrl}/invite?token=${encodeURIComponent(token)}`;
    const created = await this.store.transaction(async (client) => {
      const actorRole = await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      if (role === "admin" && actorRole !== "owner") throw new HttpError(403, "Only a team owner can invite an admin");
      const existing = await client.query("SELECT 1 FROM team_memberships m JOIN team_users u ON u.id=m.user_id WHERE m.team_id=$1 AND u.email=$2", [teamId, email]);
      if (existing.rowCount) throw new HttpError(409, "This person is already a team member");
      const team = await client.query<{ name: string }>("SELECT name FROM teams WHERE id=$1", [teamId]);
      const teamName = team.rows[0]?.name;
      if (!teamName) throw new HttpError(404, "Team not found");
      await client.query("UPDATE team_invitations SET revoked_at=$3 WHERE team_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL", [teamId, email, new Date(now)]);
      const result = await client.query<InvitationRow>(
        `INSERT INTO team_invitations(id, team_id, email, role, token_digest, invited_by, expires_at, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, team_id, email, role, expires_at, created_at`,
        [invitationId, teamId, email, role, digest(token), principal.userId, expiresAt, new Date(now)],
      );
      await this.audit(client, teamId, principal.userId, "invitation.created", "invitation", invitationId, { email, role });
      return { row: result.rows[0], teamName };
    });
    const row = created.row;
    if (!row) throw new Error("Could not create the invitation");
    let emailSent = false;
    if (this.mailer) {
      try { await this.mailer.sendInvitation(email, created.teamName, inviteUrl); emailSent = true; }
      catch { emailSent = false; }
    }
    return { invitation: { ...this.toInvitation(row), inviteUrl }, emailSent };
  }

  async revokeInvitation(principal: Principal, teamId: string, invitationId: string): Promise<void> {
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      const result = await client.query(
        `UPDATE team_invitations SET revoked_at=$3
          WHERE id=$1 AND team_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [invitationId, teamId, new Date(this.now())],
      );
      if (!result.rowCount) throw new HttpError(404, "Invitation not found or already used");
      await this.audit(client, teamId, principal.userId, "invitation.revoked", "invitation", invitationId, {});
    });
  }

  async acceptInvitation(principal: Principal, rawToken: unknown): Promise<Team> {
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new HttpError(400, "Invitation link is invalid or expired");
    return this.store.transaction(async (client) => {
      const result = await client.query<InvitationRow & { name: string; team_created_at: Date | string }>(
        `SELECT i.*, t.name, t.created_at AS team_created_at FROM team_invitations i JOIN teams t ON t.id=i.team_id
          WHERE i.token_digest=$1 FOR UPDATE OF i`, [digest(token)],
      );
      const invite = result.rows[0];
      const now = this.now();
      if (!invite || invite.accepted_at || invite.revoked_at || new Date(invite.expires_at).getTime() <= now) throw new HttpError(410, "Invitation link is invalid or expired");
      if (invite.email !== principal.email) throw new HttpError(403, "Sign in with the invited email address");
      const existing = await client.query("SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=$2", [invite.team_id, principal.userId]);
      if (existing.rowCount) throw new HttpError(409, "You are already a member of this team");
      await client.query("INSERT INTO team_memberships(team_id, user_id, role, joined_at) VALUES($1,$2,$3,$4)", [invite.team_id, principal.userId, invite.role, new Date(now)]);
      await client.query("UPDATE team_invitations SET accepted_at=$2 WHERE id=$1", [invite.id, new Date(now)]);
      await this.audit(client, invite.team_id, principal.userId, "invitation.accepted", "invitation", invite.id, { role: invite.role });
      return { id: invite.team_id, name: invite.name, role: invite.role, createdAt: this.iso(invite.team_created_at) };
    });
  }

  async updateMemberRole(principal: Principal, teamId: string, userId: string, rawRole: unknown): Promise<Member> {
    if (!ROLES.has(rawRole as TeamRole)) throw new HttpError(400, "Choose a valid member role");
    const role = rawRole as TeamRole;
    return this.store.transaction(async (client) => {
      const actorRole = await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      if ((role === "owner" || role === "admin") && actorRole !== "owner") throw new HttpError(403, "Only a team owner can assign owner or admin");
      const result = await client.query<{ role: TeamRole }>("SELECT role FROM team_memberships WHERE team_id=$1 AND user_id=$2 FOR UPDATE", [teamId, userId]);
      const current = result.rows[0]?.role;
      if (!current) throw new HttpError(404, "Team member not found");
      if ((current === "owner" || current === "admin") && actorRole !== "owner") throw new HttpError(403, "Only a team owner can change an owner or admin");
      if (current === "owner" && role !== "owner") await this.ensureAnotherOwner(client, teamId, userId);
      const updated = await client.query<{ email: string; joined_at: Date | string }>(
        `UPDATE team_memberships m SET role=$3 FROM team_users u
          WHERE m.team_id=$1 AND m.user_id=$2 AND u.id=m.user_id
          RETURNING u.email, m.joined_at`, [teamId, userId, role],
      );
      const row = updated.rows[0];
      if (!row) throw new HttpError(404, "Team member not found");
      await this.audit(client, teamId, principal.userId, "member.role_changed", "user", userId, { from: current, to: role });
      if (role === "viewer" && current !== "viewer") {
        const cancelled = await client.query<{ conversation_id: string }>(
          `UPDATE team_jobs SET status='cancelled', error_code='member_read_only', lease_token=NULL, lease_until=NULL, updated_at=$3
            WHERE team_id=$1 AND created_by=$2 AND status IN ('queued','running') RETURNING conversation_id`, [teamId, userId, new Date(this.now())],
        );
        await this.notifyConversations(client, cancelled.rows.map((item) => item.conversation_id));
        await this.cancelCodeTasksForMember(client, teamId, userId, "member_read_only");
      }
      return { userId, email: row.email, role, joinedAt: this.iso(row.joined_at) };
    });
  }

  async removeMember(principal: Principal, teamId: string, userId: string): Promise<void> {
    if (principal.userId === userId) throw new HttpError(400, "Use leave-team after transferring ownership");
    await this.store.transaction(async (client) => {
      const actorRole = await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      const result = await client.query<{ role: TeamRole }>("SELECT role FROM team_memberships WHERE team_id=$1 AND user_id=$2 FOR UPDATE", [teamId, userId]);
      const role = result.rows[0]?.role;
      if (!role) throw new HttpError(404, "Team member not found");
      if ((role === "owner" || role === "admin") && actorRole !== "owner") throw new HttpError(403, "Only a team owner can remove an owner or admin");
      if (role === "owner") await this.ensureAnotherOwner(client, teamId, userId);
      const cancelled = await client.query<{ conversation_id: string }>(
        `UPDATE team_jobs SET status='cancelled', error_code='member_removed', lease_token=NULL, lease_until=NULL, updated_at=$3
          WHERE team_id=$1 AND created_by=$2 AND status IN ('queued','running') RETURNING conversation_id`, [teamId, userId, new Date(this.now())],
      );
      await this.notifyConversations(client, cancelled.rows.map((item) => item.conversation_id));
      await this.cancelCodeTasksForMember(client, teamId, userId, "member_removed");
      await client.query("DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2", [teamId, userId]);
      await this.audit(client, teamId, principal.userId, "member.removed", "user", userId, { role });
    });
  }

  async leaveTeam(principal: Principal, teamId: string): Promise<void> {
    await this.store.transaction(async (client) => {
      const result = await client.query<{ role: TeamRole }>(
        "SELECT role FROM team_memberships WHERE team_id=$1 AND user_id=$2 FOR UPDATE", [teamId, principal.userId],
      );
      const role = result.rows[0]?.role;
      if (!role) throw new HttpError(404, "Team not found");
      if (role === "owner") await this.ensureAnotherOwner(client, teamId, principal.userId);
      const now = new Date(this.now());
      const cancelled = await client.query<{ conversation_id: string }>(
        `UPDATE team_jobs SET status='cancelled', error_code='member_left', lease_token=NULL, lease_until=NULL, updated_at=$3
          WHERE team_id=$1 AND created_by=$2 AND status IN ('queued','running') RETURNING conversation_id`, [teamId, principal.userId, now],
      );
      await this.notifyConversations(client, cancelled.rows.map((item) => item.conversation_id));
      await this.cancelCodeTasksForMember(client, teamId, principal.userId, "member_left");
      await client.query("DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2", [teamId, principal.userId]);
      await this.audit(client, teamId, principal.userId, "member.left", "user", principal.userId, { role });
    });
  }

  async getModelConfig(principal: Principal, teamId: string): Promise<TeamModelConfig> {
    const role = await this.requireMembership(principal, teamId);
    const result = await this.store.pool.query<{ model: string; key_tail: string }>(
      "SELECT model, key_tail FROM team_model_credentials WHERE team_id=$1", [teamId],
    );
    const row = result.rows[0];
    return row ? {
      configured: true,
      ...(this.config.modelBaseUrl ? { modelBaseUrl: this.config.modelBaseUrl } : {}),
      model: row.model,
      ...((role === "owner" || role === "admin") ? { keyTail: row.key_tail } : {}),
    } : { configured: false, ...(this.config.modelBaseUrl ? { modelBaseUrl: this.config.modelBaseUrl } : {}) };
  }

  async saveModelConfig(principal: Principal, teamId: string, input: { model?: unknown; apiKey?: unknown }): Promise<TeamModelConfig> {
    if (!this.config.modelBaseUrl) throw new HttpError(503, "The team service model endpoint is not configured");
    const model = typeof input.model === "string" ? input.model.trim() : "";
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) throw new HttpError(400, "Enter a valid model identifier");
    if (!apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new HttpError(400, "Enter a valid model API key");
    const encryptedApiKey = encryptCredential(this.config.credentialSecret, apiKey);
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      await client.query(
        `INSERT INTO team_model_credentials(team_id, model, encrypted_api_key, key_tail, updated_by, updated_at)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(team_id) DO UPDATE SET model=EXCLUDED.model, encrypted_api_key=EXCLUDED.encrypted_api_key,
           key_tail=EXCLUDED.key_tail, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [teamId, model, encryptedApiKey, credentialTail(apiKey), principal.userId, new Date(this.now())],
      );
      const cancelled = await client.query<{ conversation_id: string }>(
        `UPDATE team_jobs SET status='cancelled', error_code='model_key_rotated', lease_token=NULL, lease_until=NULL, updated_at=$2
          WHERE team_id=$1 AND status IN ('queued','running') RETURNING conversation_id`, [teamId, new Date(this.now())],
      );
      await this.notifyConversations(client, cancelled.rows.map((item) => item.conversation_id));
      await this.cancelCodeTasksForModelCredential(client, teamId, "model_key_rotated");
      await this.audit(client, teamId, principal.userId, "model_credentials.updated", "model_credentials", teamId, { model });
    });
    return { configured: true, modelBaseUrl: this.config.modelBaseUrl, model, keyTail: credentialTail(apiKey) };
  }

  async deleteModelConfig(principal: Principal, teamId: string): Promise<void> {
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      await client.query("DELETE FROM team_model_credentials WHERE team_id=$1", [teamId]);
      const cancelled = await client.query<{ conversation_id: string }>(
        `UPDATE team_jobs SET status='cancelled', error_code='model_key_deleted', lease_token=NULL, lease_until=NULL, updated_at=$2
          WHERE team_id=$1 AND status IN ('queued','running') RETURNING conversation_id`, [teamId, new Date(this.now())],
      );
      await this.notifyConversations(client, cancelled.rows.map((item) => item.conversation_id));
      await this.cancelCodeTasksForModelCredential(client, teamId, "model_key_deleted");
      await this.audit(client, teamId, principal.userId, "model_credentials.deleted", "model_credentials", teamId, {});
    });
  }

  async getModelCredential(teamId: string): Promise<{ model: string; apiKey: string } | undefined> {
    const result = await this.store.pool.query<{ model: string; encrypted_api_key: string }>(
      "SELECT model, encrypted_api_key FROM team_model_credentials WHERE team_id=$1", [teamId],
    );
    const row = result.rows[0];
    return row ? { model: row.model, apiKey: this.decryptApiKey(row.encrypted_api_key) } : undefined;
  }

  private decryptApiKey(encrypted: string): string {
    return decryptCredential(this.config.credentialSecret, encrypted);
  }

  /**
   * 读取团队模型授权策略与当前成员的可选模型。
   * 任何团队成员都能读：成员需要知道自己被授权了什么，才能自主选择模型。
   */
  async getModelPolicy(principal: Principal, teamId: string): Promise<TeamModelPolicy> {
    await this.requireMembership(principal, teamId);
    const [policy, memberModel, teamModel] = await Promise.all([
      this.store.pool.query<{ mode: TeamModelPolicyMode; allowed_models: string[]; updated_at: Date | string }>(
        "SELECT mode, allowed_models, updated_at FROM team_model_policies WHERE team_id=$1", [teamId],
      ),
      this.store.pool.query<{ model: string }>(
        "SELECT model FROM team_member_models WHERE team_id=$1 AND user_id=$2", [teamId, principal.userId],
      ),
      this.store.pool.query<{ model: string }>(
        "SELECT model FROM team_model_credentials WHERE team_id=$1", [teamId],
      ),
    ]);
    const row = policy.rows[0];
    const mode: TeamModelPolicyMode = row?.mode ?? "all";
    const allowedModels = row?.allowed_models ?? [];
    const catalogModels = this.config.modelCatalog;
    const availableModels = this.availableModelsFor(mode, allowedModels, catalogModels, teamModel.rows[0]?.model);
    const selected = memberModel.rows[0]?.model;
    return {
      mode,
      allowedModels,
      catalogModels,
      availableModels,
      ...(selected ? { memberModel: selected } : {}),
      ...(row?.updated_at ? { updatedAt: this.iso(new Date(row.updated_at)) } : {}),
    };
  }

  /**
   * 设置团队模型授权策略。仅所有者和管理员可以设置。
   * mode=allowlist 时 allowedModels 必填；mode=catalog 使用部署侧登记的目录；mode=all 不限制。
   */
  async saveModelPolicy(principal: Principal, teamId: string, input: { mode?: unknown; allowedModels?: unknown }): Promise<TeamModelPolicy> {
    const mode = input.mode === "all" || input.mode === "catalog" || input.mode === "allowlist" ? input.mode : undefined;
    if (!mode) throw new HttpError(400, "Choose a valid model access mode");
    const allowedModels = this.parseAllowedModels(input.allowedModels);
    if (mode === "allowlist" && !allowedModels.length) throw new HttpError(400, "Select at least one model for the allowlist");
    if (mode === "catalog" && !this.config.modelCatalog.length) throw new HttpError(409, "No deployment model catalog is configured on this server");
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      await client.query(
        `INSERT INTO team_model_policies(team_id, mode, allowed_models, updated_by, updated_at)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(team_id) DO UPDATE SET mode=EXCLUDED.mode, allowed_models=EXCLUDED.allowed_models,
           updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [teamId, mode, allowedModels, principal.userId, new Date(this.now())],
      );
      // 策略收紧后，成员此前选择的模型可能已越权，清掉这些偏好
      const stillPermitted = mode === "allowlist" ? allowedModels : mode === "catalog" ? this.config.modelCatalog : undefined;
      if (stillPermitted) {
        await client.query(
          `DELETE FROM team_member_models WHERE team_id=$1 AND NOT (model = ANY($2::text[]))`, [teamId, stillPermitted],
        );
      }
      await this.audit(client, teamId, principal.userId, "model_policy.updated", "model_policy", teamId, { mode, allowedModels });
    });
    return this.getModelPolicy(principal, teamId);
  }

  /**
   * 成员设置自己在授权范围内的模型偏好。空串表示清除偏好、跟随团队默认。
   */
  async saveMemberModel(principal: Principal, teamId: string, rawModel: unknown): Promise<TeamModelPolicy> {
    const requested = rawModel === "" || rawModel === null || rawModel === undefined ? undefined : normalizeModelId(rawModel);
    if (rawModel !== "" && rawModel !== null && rawModel !== undefined && !requested) throw new HttpError(400, "Enter a valid model identifier");
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin", "developer"]));
      const policy = await client.query<{ mode: TeamModelPolicyMode; allowed_models: string[] }>(
        "SELECT mode, allowed_models FROM team_model_policies WHERE team_id=$1 FOR SHARE", [teamId],
      );
      const row = policy.rows[0];
      const mode: TeamModelPolicyMode = row?.mode ?? "all";
      const allowedModels = row?.allowed_models ?? [];
      if (requested && !isModelPermitted(mode, allowedModels, this.config.modelCatalog, requested)) {
        throw new HttpError(403, "This model is not available to you in the team model policy");
      }
      if (requested) {
        await client.query(
          `INSERT INTO team_member_models(team_id, user_id, model, updated_at) VALUES($1,$2,$3,$4)
           ON CONFLICT(team_id, user_id) DO UPDATE SET model=EXCLUDED.model, updated_at=EXCLUDED.updated_at`,
          [teamId, principal.userId, requested, new Date(this.now())],
        );
      } else {
        await client.query("DELETE FROM team_member_models WHERE team_id=$1 AND user_id=$2", [teamId, principal.userId]);
      }
      await this.audit(client, teamId, principal.userId, "model_policy.member_model", "model_policy", teamId, { model: requested ?? null });
    });
    return this.getModelPolicy(principal, teamId);
  }

  // —— 叠加限制层（规则）——

  /** 列出团队的叠加限制规则。成员可读：需要知道自己受哪些额外约束。 */
  async listPolicyRules(principal: Principal, teamId: string): Promise<TeamModelPolicyRule[]> {
    await this.requireMembership(principal, teamId);
    const result = await this.store.pool.query<PolicyRuleRow>(
      `SELECT id, team_id, rule_name, enabled, allowed_models, blocked_models,
              max_requests_per_user_per_hour, max_requests_per_team_per_hour,
              max_input_tokens_per_request, max_output_tokens_per_request,
              max_total_tokens_per_user_per_day, applies_to_roles, priority,
              created_by, created_at, updated_at
         FROM team_model_policy_rules WHERE team_id=$1
        ORDER BY priority DESC, created_at`,
      [teamId],
    );
    return result.rows.map((row) => this.toPolicyRule(row));
  }

  /** 读取单条规则。 */
  async getPolicyRule(principal: Principal, teamId: string, ruleId: string): Promise<TeamModelPolicyRule> {
    await this.requireMembership(principal, teamId);
    const result = await this.store.pool.query<PolicyRuleRow>(
      `SELECT id, team_id, rule_name, enabled, allowed_models, blocked_models,
              max_requests_per_user_per_hour, max_requests_per_team_per_hour,
              max_input_tokens_per_request, max_output_tokens_per_request,
              max_total_tokens_per_user_per_day, applies_to_roles, priority,
              created_by, created_at, updated_at
         FROM team_model_policy_rules WHERE team_id=$1 AND id=$2`,
      [teamId, ruleId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Policy rule not found");
    return this.toPolicyRule(row);
  }

  /** 新建一条叠加限制规则。仅所有者和管理员可以设置。 */
  async createPolicyRule(principal: Principal, teamId: string, input: unknown): Promise<TeamModelPolicyRule> {
    const body = (input ?? {}) as Record<string, unknown>;
    const ruleName = typeof body.ruleName === "string" ? body.ruleName.trim() : "";
    if (!ruleName || ruleName.length > 100) throw new HttpError(400, "Give the rule a name of 1-100 characters");
    const parsed = this.parseRuleBody(body);
    const id = randomBytes(16).toString("hex");
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      await client.query(
        `INSERT INTO team_model_policy_rules(
            id, team_id, rule_name, enabled, allowed_models, blocked_models,
            max_requests_per_user_per_hour, max_requests_per_team_per_hour,
            max_input_tokens_per_request, max_output_tokens_per_request,
            max_total_tokens_per_user_per_day, applies_to_roles, priority, created_by, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
        [
          id, teamId, ruleName, parsed.enabled, parsed.allowedModels, parsed.blockedModels,
          parsed.maxRequestsPerUserPerHour, parsed.maxRequestsPerTeamPerHour,
          parsed.maxInputTokensPerRequest, parsed.maxOutputTokensPerRequest,
          parsed.maxTotalTokensPerUserPerDay, parsed.appliesToRoles, parsed.priority,
          principal.userId, new Date(this.now()),
        ],
      );
      await this.audit(client, teamId, principal.userId, "model_policy.rule_created", "model_policy_rule", id, { ruleName });
    });
    return this.getPolicyRule(principal, teamId, id);
  }

  /** 修改一条规则。 */
  async updatePolicyRule(principal: Principal, teamId: string, ruleId: string, input: unknown): Promise<TeamModelPolicyRule> {
    const body = (input ?? {}) as Record<string, unknown>;
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM team_model_policy_rules WHERE team_id=$1 AND id=$2", [teamId, ruleId],
      );
      if (!existing.rows[0]) throw new HttpError(404, "Policy rule not found");
      const parsed = this.parseRuleBody(body);
      const updates: string[] = [];
      const values: unknown[] = [];
      const push = (fragment: string, value: unknown) => { values.push(value); updates.push(`${fragment} = $${values.length}`); };
      if (body.ruleName !== undefined) {
        const ruleName = typeof body.ruleName === "string" ? body.ruleName.trim() : "";
        if (!ruleName || ruleName.length > 100) throw new HttpError(400, "Give the rule a name of 1-100 characters");
        push("rule_name", ruleName);
      }
      if (body.enabled !== undefined) push("enabled", parsed.enabled);
      if (body.allowedModels !== undefined) push("allowed_models", parsed.allowedModels);
      if (body.blockedModels !== undefined) push("blocked_models", parsed.blockedModels);
      if (body.maxRequestsPerUserPerHour !== undefined) push("max_requests_per_user_per_hour", parsed.maxRequestsPerUserPerHour);
      if (body.maxRequestsPerTeamPerHour !== undefined) push("max_requests_per_team_per_hour", parsed.maxRequestsPerTeamPerHour);
      if (body.maxInputTokensPerRequest !== undefined) push("max_input_tokens_per_request", parsed.maxInputTokensPerRequest);
      if (body.maxOutputTokensPerRequest !== undefined) push("max_output_tokens_per_request", parsed.maxOutputTokensPerRequest);
      if (body.maxTotalTokensPerUserPerDay !== undefined) push("max_total_tokens_per_user_per_day", parsed.maxTotalTokensPerUserPerDay);
      if (body.appliesToRoles !== undefined) push("applies_to_roles", parsed.appliesToRoles);
      if (body.priority !== undefined) push("priority", parsed.priority);
      if (!updates.length) throw new HttpError(400, "Nothing to update");
      values.push(new Date(this.now()));
      await client.query(
        `UPDATE team_model_policy_rules SET ${updates.join(", ")}, updated_at = $${values.length}
          WHERE team_id = $${values.length + 1} AND id = $${values.length + 2}`,
        [...values, teamId, ruleId],
      );
      await this.audit(client, teamId, principal.userId, "model_policy.rule_updated", "model_policy_rule", ruleId, {});
    });
    return this.getPolicyRule(principal, teamId, ruleId);
  }

  /** 删除一条规则。 */
  async deletePolicyRule(principal: Principal, teamId: string, ruleId: string): Promise<void> {
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      const result = await client.query(
        "DELETE FROM team_model_policy_rules WHERE team_id=$1 AND id=$2", [teamId, ruleId],
      );
      if (!result.rowCount) throw new HttpError(404, "Policy rule not found");
      await this.audit(client, teamId, principal.userId, "model_policy.rule_deleted", "model_policy_rule", ruleId, {});
    });
  }

  /** 批量启用/停用规则。 */
  async setPolicyRulesEnabled(principal: Principal, teamId: string, ruleIds: string[], enabled: boolean): Promise<void> {
    if (!ruleIds.length) return;
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      await client.query(
        "UPDATE team_model_policy_rules SET enabled=$3, updated_at=$4 WHERE team_id=$1 AND id = ANY($2::text[])",
        [teamId, ruleIds, enabled, new Date(this.now())],
      );
      await this.audit(client, teamId, principal.userId, enabled ? "model_policy.rules_enabled" : "model_policy.rules_disabled", "model_policy_rule", teamId, { ruleIds });
    });
  }

  /** 违规记录，供审计与告警查看。 */
  async listPolicyViolations(principal: Principal, teamId: string, limit = 100): Promise<TeamModelPolicyViolation[]> {
    await this.requireMembership(principal, teamId);
    const result = await this.store.pool.query<{
      id: string; team_id: string; rule_id: string | null; user_id: string | null;
      violation_type: string; model_requested: string | null; details: unknown; created_at: Date | string;
      rule_name: string | null; user_email: string | null;
    }>(
      `SELECT v.id, v.team_id, v.rule_id, v.user_id, v.violation_type, v.model_requested, v.details, v.created_at,
              r.rule_name, u.email AS user_email
         FROM team_model_policy_violations v
         LEFT JOIN team_model_policy_rules r ON r.id = v.rule_id
         LEFT JOIN team_users u ON u.id = v.user_id
        WHERE v.team_id=$1
        ORDER BY v.created_at DESC
        LIMIT $2`,
      [teamId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      teamId: row.team_id,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      userId: row.user_id,
      userEmail: row.user_email,
      violationType: row.violation_type,
      modelRequested: row.model_requested,
      details: (row.details ?? {}) as Record<string, unknown>,
      createdAt: this.iso(row.created_at),
    }));
  }

  /** 校验并归一化规则内容。 */
  private parseRuleBody(body: Record<string, unknown>): {
    enabled: boolean;
    allowedModels: string[];
    blockedModels: string[];
    maxRequestsPerUserPerHour: number | null;
    maxRequestsPerTeamPerHour: number | null;
    maxInputTokensPerRequest: number | null;
    maxOutputTokensPerRequest: number | null;
    maxTotalTokensPerUserPerDay: string | null;
    appliesToRoles: TeamRole[];
    priority: number;
  } {
    const enabled = body.enabled === undefined ? true : body.enabled === true;
    const allowedModels = this.parseAllowedModels(body.allowedModels);
    const blockedModels = this.parseAllowedModels(body.blockedModels);
    const roles: TeamRole[] = [];
    if (Array.isArray(body.appliesToRoles)) {
      for (const item of body.appliesToRoles) {
        if (item === "owner" || item === "admin" || item === "developer" || item === "viewer") {
          if (!roles.includes(item)) roles.push(item);
        } else throw new HttpError(400, "Unknown team role in appliesToRoles");
      }
    } else if (body.appliesToRoles !== undefined) {
      throw new HttpError(400, "appliesToRoles must be a list of team roles");
    }
    const positiveInt = (value: unknown, label: string): number | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new HttpError(400, `${label} must be a positive whole number`);
      }
      return value;
    };
    const priority = body.priority === undefined ? 100
      : typeof body.priority === "number" && Number.isSafeInteger(body.priority) && body.priority >= 0 && body.priority <= 1000
        ? body.priority
        : (() => { throw new HttpError(400, "priority must be a whole number between 0 and 1000"); })();
    let maxTotalTokensPerUserPerDay: string | null = null;
    if (body.maxTotalTokensPerUserPerDay !== undefined && body.maxTotalTokensPerUserPerDay !== null) {
      const value = body.maxTotalTokensPerUserPerDay;
      if (typeof value !== "number" && typeof value !== "string") throw new HttpError(400, "maxTotalTokensPerUserPerDay must be a positive whole number");
      const parsed = BigInt(value);
      if (parsed <= 0n) throw new HttpError(400, "maxTotalTokensPerUserPerDay must be a positive whole number");
      maxTotalTokensPerUserPerDay = parsed.toString();
    }
    return {
      enabled,
      allowedModels,
      blockedModels,
      maxRequestsPerUserPerHour: positiveInt(body.maxRequestsPerUserPerHour, "maxRequestsPerUserPerHour"),
      maxRequestsPerTeamPerHour: positiveInt(body.maxRequestsPerTeamPerHour, "maxRequestsPerTeamPerHour"),
      maxInputTokensPerRequest: positiveInt(body.maxInputTokensPerRequest, "maxInputTokensPerRequest"),
      maxOutputTokensPerRequest: positiveInt(body.maxOutputTokensPerRequest, "maxOutputTokensPerRequest"),
      maxTotalTokensPerUserPerDay,
      appliesToRoles: roles.length ? roles : ["owner", "admin", "developer", "viewer"],
      priority,
    };
  }

  private toPolicyRule(row: PolicyRuleRow): TeamModelPolicyRule {
    return {
      id: row.id,
      teamId: row.team_id,
      ruleName: row.rule_name,
      enabled: row.enabled,
      allowedModels: row.allowed_models ?? [],
      blockedModels: row.blocked_models ?? [],
      maxRequestsPerUserPerHour: row.max_requests_per_user_per_hour,
      maxRequestsPerTeamPerHour: row.max_requests_per_team_per_hour,
      maxInputTokensPerRequest: row.max_input_tokens_per_request,
      maxOutputTokensPerRequest: row.max_output_tokens_per_request,
      maxTotalTokensPerUserPerDay: row.max_total_tokens_per_user_per_day === null
        ? null
        : String(row.max_total_tokens_per_user_per_day),
      appliesToRoles: (row.applies_to_roles ?? []) as TeamRole[],
      priority: row.priority,
      createdBy: row.created_by,
      createdAt: this.iso(row.created_at),
      updatedAt: this.iso(row.updated_at),
    };
  }

  /** 成员可选的模型列表：授权范围 ∩ 部署目录，并与团队默认模型合并 */
  private availableModelsFor(
    mode: TeamModelPolicyMode,
    allowedModels: string[],
    catalogModels: string[],
    teamModel?: string,
  ): string[] {
    const permitted = permittedModels(mode, allowedModels, catalogModels);
    if (!permitted) {
      // 不限制：团队默认模型 + 部署目录里其他模型
      return dedupeModels([...(teamModel ? [teamModel] : []), ...catalogModels]);
    }
    const list = dedupeModels([...permitted, ...(teamModel && permitted.includes(teamModel) ? [teamModel] : [])]);
    return list;
  }

  private parseAllowedModels(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const models: string[] = [];
    for (const item of raw) {
      const model = normalizeModelId(item);
      if (!model) throw new HttpError(400, "Enter a valid model identifier");
      models.push(model);
    }
    if (models.length > 50) throw new HttpError(400, "Select at most 50 models");
    return dedupeModels(models);
  }

  /**
   * 解析某成员在当前授权策略下实际使用的模型（事务内版本）。
   * 返回 undefined 表示该成员当前没有任何可用模型。
   */
  private async resolveModelForMemberIn(
    client: PoolClient,
    teamId: string,
    userId: string,
    teamModel?: string,
  ): Promise<string | undefined> {
    const [policy, member] = await Promise.all([
      client.query<{ mode: TeamModelPolicyMode; allowed_models: string[] }>(
        "SELECT mode, allowed_models FROM team_model_policies WHERE team_id=$1", [teamId],
      ),
      client.query<{ model: string }>(
        "SELECT model FROM team_member_models WHERE team_id=$1 AND user_id=$2", [teamId, userId],
      ),
    ]);
    const row = policy.rows[0];
    const mode: TeamModelPolicyMode = row?.mode ?? "all";
    return resolveMemberModel({
      mode,
      allowedModels: row?.allowed_models ?? [],
      catalogModels: this.config.modelCatalog,
      memberModel: member.rows[0]?.model,
      teamModel,
    });
  }

  /**
   * 解析某成员在当前授权策略下实际使用的模型。
   * 返回 undefined 表示该成员当前没有任何可用模型。
   */
  async listProjects(principal: Principal, teamId: string): Promise<TeamProject[]> {
    const result = await this.store.pool.query<ProjectRow>(
      `SELECT p.id, p.team_id, p.name, p.provider, p.repository_url, p.clone_url, p.default_branch, p.created_by, p.created_at
         FROM team_projects p JOIN team_memberships m ON m.team_id=p.team_id AND m.user_id=$2
        WHERE p.team_id=$1 ORDER BY p.created_at DESC, p.id`, [teamId, principal.userId],
    );
    return result.rows.map((row) => this.toProject(row));
  }

  async createProject(principal: Principal, teamId: string, input: { name?: unknown; repositoryUrl?: unknown; defaultBranch?: unknown }): Promise<TeamProject> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length < 1 || name.length > 80) throw new HttpError(400, "Project name must be between 1 and 80 characters");
    const repository = normalizeRepositoryUrl(input.repositoryUrl);
    // 未显式指定默认分支时，向代码托管方探测真实默认分支；
    // 探测失败（私有仓库、无凭据、网络不通）则回落到 main，不阻断建项目。
    const explicitBranch = typeof input.defaultBranch === "string" && input.defaultBranch.trim().length > 0;
    const defaultBranch = explicitBranch
      ? normalizeBranch(input.defaultBranch)
      : await this.detectDefaultBranch(repository.provider, repository.repositoryUrl);
    const projectId = id();
    try {
      return await this.store.transaction(async (client) => {
        await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
        const result = await client.query<ProjectRow>(
          `INSERT INTO team_projects(id, team_id, name, provider, repository_url, clone_url, default_branch, created_by, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, team_id, name, provider, repository_url, clone_url, default_branch, created_by, created_at`,
          [projectId, teamId, name, repository.provider, repository.repositoryUrl, repository.cloneUrl, defaultBranch, principal.userId, new Date(this.now())],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Could not create the team project");
        await this.audit(client, teamId, principal.userId, "project.created", "project", projectId, { name, provider: repository.provider, defaultBranch });
        return this.toProject(row);
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === "23505") throw new HttpError(409, "This repository is already registered in the team");
      throw error;
    }
  }

  async getProject(principal: Principal, teamId: string, projectId: string): Promise<TeamProject> {
    const result = await this.store.pool.query<ProjectRow>(
      `SELECT p.id, p.team_id, p.name, p.provider, p.repository_url, p.clone_url, p.default_branch, p.created_by, p.created_at
         FROM team_projects p JOIN team_memberships m ON m.team_id=p.team_id AND m.user_id=$3
        WHERE p.team_id=$1 AND p.id=$2`, [teamId, projectId, principal.userId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Team project not found");
    return this.toProject(row);
  }

  async deleteProject(principal: Principal, teamId: string, projectId: string): Promise<void> {
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      const result = await client.query<{ name: string }>("DELETE FROM team_projects WHERE team_id=$1 AND id=$2 RETURNING name", [teamId, projectId]);
      const project = result.rows[0];
      if (!project) throw new HttpError(404, "Team project not found");
      await this.audit(client, teamId, principal.userId, "project.deleted", "project", projectId, { name: project.name });
    });
  }

  async listCodeTasks(principal: Principal, teamId: string, projectId: string): Promise<TeamCodeTask[]> {
    await this.getProject(principal, teamId, projectId);
    const result = await this.store.pool.query<CodeTaskRow>(
      `SELECT id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at, executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at
         FROM team_code_tasks WHERE team_id=$1 AND project_id=$2 ORDER BY created_at DESC, id DESC LIMIT 100`, [teamId, projectId],
    );
    return result.rows.map((row) => this.toCodeTask(row));
  }

  async createCodeTask(principal: Principal, teamId: string, projectId: string, input: { branch?: unknown; instructions?: unknown }): Promise<TeamCodeTask> {
    // 未指定分支时用项目的默认分支，而不是直接报错 —— 前端不必知道每个仓库的默认分支。
    const requested = typeof input.branch === "string" && input.branch.trim().length > 0 ? input.branch : undefined;
    const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
    if (!instructions || instructions.length > 20_000) throw new HttpError(400, "Code task instructions must be between 1 and 20000 characters");
    const taskId = id();
    return this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin", "developer"]));
      const project = await client.query<{ id: string; default_branch: string }>(
        "SELECT id, default_branch FROM team_projects WHERE team_id=$1 AND id=$2 FOR SHARE",
        [teamId, projectId],
      );
      if (!project.rows[0]) throw new HttpError(404, "Team project not found");
      const branch = normalizeBranch(requested ?? project.rows[0].default_branch);
      const result = await client.query<CodeTaskRow>(
        `INSERT INTO team_code_tasks(id, team_id, project_id, created_by, branch, instructions, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7)
         RETURNING id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at, executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at`,
        [taskId, teamId, projectId, principal.userId, branch, instructions, new Date(this.now())],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Could not create the code task");
      await this.audit(client, teamId, principal.userId, "code_task.created", "code_task", taskId, { projectId, branch, status: row.status });
      return this.toCodeTask(row);
    });
  }

  async decideCodeTask(principal: Principal, teamId: string, projectId: string, taskId: string, decision: "approve" | "reject", rawReason: unknown): Promise<TeamCodeTask> {
    if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "Choose approve or reject");
    const reason = typeof rawReason === "string" ? rawReason.trim() : "";
    if (reason.length > 4_000) throw new HttpError(400, "Decision reason must be at most 4000 characters");
    return this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      const result = await client.query<CodeTaskRow>(
        `SELECT id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at, executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at
           FROM team_code_tasks WHERE id=$1 AND team_id=$2 AND project_id=$3 FOR UPDATE`, [taskId, teamId, projectId],
      );
      const task = result.rows[0];
      if (!task) throw new HttpError(404, "Code task not found");
      if (task.status !== "pending_approval") throw new HttpError(409, "This code task has already been decided");
      const status: TeamCodeTaskStatus = decision === "approve" ? "approved_waiting_executor" : "rejected";
      const decidedAt = new Date(this.now());
      const updated = await client.query<CodeTaskRow>(
        `UPDATE team_code_tasks SET status=$4, decision_reason=$5, decided_by=$6, decided_at=$7, updated_at=$7
          WHERE id=$1 AND team_id=$2 AND project_id=$3
          RETURNING id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at, executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at`,
        [taskId, teamId, projectId, status, reason || null, principal.userId, decidedAt],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("Could not decide the code task");
      await this.audit(client, teamId, principal.userId, `code_task.${decision === "approve" ? "approved" : "rejected"}`, "code_task", taskId, { projectId, reason: reason || undefined });
      return this.toCodeTask(row);
    });
  }

  async cancelCodeTask(principal: Principal, teamId: string, projectId: string, taskId: string): Promise<TeamCodeTask> {
    return this.store.transaction(async (client) => {
      const member = await client.query<{ role: TeamRole }>("SELECT role FROM team_memberships WHERE team_id=$1 AND user_id=$2 FOR SHARE", [teamId, principal.userId]);
      const role = member.rows[0]?.role;
      if (!role) throw new HttpError(404, "Team not found");
      const result = await client.query<CodeTaskRow>(
        `SELECT id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at, executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at
           FROM team_code_tasks WHERE id=$1 AND team_id=$2 AND project_id=$3 FOR UPDATE`, [taskId, teamId, projectId],
      );
      const task = result.rows[0];
      if (!task) throw new HttpError(404, "Code task not found");
      if (task.created_by !== principal.userId && role !== "owner" && role !== "admin") throw new HttpError(403, "You cannot cancel this code task");
      if (task.status === "rejected" || task.status === "cancelled" || task.status === "succeeded" || task.status === "failed") throw new HttpError(409, "This code task is already closed");
      const updated = await client.query<CodeTaskRow>(
        `UPDATE team_code_tasks SET status='cancelled', executor_capability_hash=NULL, executor_capability_encrypted=NULL, executor_lease_until=NULL, updated_at=$4 WHERE id=$1 AND team_id=$2 AND project_id=$3
          RETURNING id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at, executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at`,
        [taskId, teamId, projectId, new Date(this.now())],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("Could not cancel the code task");
      await this.audit(client, teamId, principal.userId, "code_task.cancelled", "code_task", taskId, { projectId });
      return this.toCodeTask(row);
    });
  }

  async claimCodeTaskForExecutor(): Promise<CodeTaskDispatch | undefined> {
    return this.store.transaction(async (client) => {
      const now = new Date(this.now());
      await client.query(
        `UPDATE team_code_tasks SET status='failed', executor_error='executor dispatch lease expired', executor_capability_hash=NULL, executor_capability_encrypted=NULL, executor_finished_at=$1, updated_at=$1
          WHERE status='dispatching' AND executor_attempts >= 3 AND executor_lease_until IS NOT NULL AND executor_lease_until <= $1`, [now],
      );
      const result = await client.query<CodeTaskRow & { repository_url: string; default_branch: string; model: string }>(
        `SELECT t.id, t.team_id, t.project_id, t.created_by, t.branch, t.instructions, t.status, t.decision_reason, t.decided_by, t.decided_at,
                t.executor_job_id, t.executor_attempts, t.executor_lease_until, t.executor_started_at, t.executor_finished_at, t.executor_result, t.executor_error,
                t.executor_capability_hash, t.executor_capability_encrypted, t.executor_model_requests,
                t.created_at, t.updated_at, p.repository_url, p.default_branch, c.model
           FROM team_code_tasks t JOIN team_projects p ON p.id=t.project_id AND p.team_id=t.team_id
           JOIN team_model_credentials c ON c.team_id=t.team_id
          WHERE t.executor_attempts < 3 AND (t.status='approved_waiting_executor' OR (t.status='dispatching' AND t.executor_lease_until IS NOT NULL AND t.executor_lease_until <= $1))
          ORDER BY t.updated_at, t.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now],
      );
      const task = result.rows[0];
      if (!task) return undefined;
      // 本次任务实际使用的模型：成员在授权范围内的选择，落在范围外时回落到团队默认模型
      const resolvedModel = await this.resolveModelForMemberIn(client, task.team_id, task.created_by, task.model);
      if (!resolvedModel) return undefined;
      const jobId = task.executor_job_id ?? `ct_${id()}`;
      const capabilityToken = task.executor_capability_encrypted
        ? decryptCredential(this.config.credentialSecret, task.executor_capability_encrypted)
        : this.makeSecret(32);
      const capabilityHash = task.executor_capability_hash ?? digest(capabilityToken);
      const encryptedCapability = task.executor_capability_encrypted ?? encryptCredential(this.config.credentialSecret, capabilityToken);
      const updated = await client.query<{ executor_attempts: number }>(
        `UPDATE team_code_tasks SET status='dispatching', executor_job_id=$2, executor_attempts=executor_attempts+1,
                executor_error=NULL, executor_lease_until=$3, executor_capability_hash=$4, executor_capability_encrypted=$5,
                executor_model=$6, updated_at=$3 WHERE id=$1 AND executor_attempts < 3
                AND (status='approved_waiting_executor' OR (status='dispatching' AND executor_lease_until IS NOT NULL AND executor_lease_until <= $3))
         RETURNING executor_attempts`, [task.id, jobId, new Date(this.now() + 30_000), capabilityHash, encryptedCapability, resolvedModel],
      );
      if (!updated.rows[0]) return undefined;
      await this.audit(client, task.team_id, null, "code_task.dispatching", "code_task", task.id, { jobId, executorAttempts: updated.rows[0].executor_attempts, model: resolvedModel });
      return {
        jobId, capabilityToken, brokerUrl: this.config.codeExecutorBrokerUrl, model: resolvedModel, taskId: task.id, teamId: task.team_id, projectId: task.project_id, repositoryUrl: task.repository_url,
        defaultBranch: task.default_branch, branch: task.branch, instructions: task.instructions, createdBy: task.created_by,
        executorAttempts: updated.rows[0].executor_attempts,
      };
    });
  }

  async expireCodeTaskLeases(): Promise<number> {
    return this.store.transaction(async (client) => {
      const now = new Date(this.now());
      const expired = await client.query<CodeTaskRow>(
        `UPDATE team_code_tasks SET status='failed', executor_error='executor_lease_expired', executor_lease_until=NULL, executor_capability_hash=NULL, executor_capability_encrypted=NULL, executor_finished_at=$1, updated_at=$1
          WHERE status='running' AND executor_lease_until IS NOT NULL AND executor_lease_until <= $1
          RETURNING id, team_id`, [now],
      );
      for (const task of expired.rows) await this.audit(client, task.team_id, null, "code_task.failed", "code_task", task.id, { error: "executor_lease_expired" });
      return expired.rows.length;
    });
  }

  async markCodeTaskDispatchAccepted(jobId: string): Promise<TeamCodeTask | undefined> {
    return this.store.transaction(async (client) => {
      const at = new Date(this.now());
      const leaseUntil = new Date(at.getTime() + EXECUTOR_RUNNING_LEASE_MS);
      const updated = await client.query<CodeTaskRow>(
        `UPDATE team_code_tasks SET status='running', executor_started_at=$2, executor_lease_until=$3, executor_error=NULL, updated_at=$2
          WHERE executor_job_id=$1 AND status='dispatching'
          RETURNING id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at,
                    executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at`,
        [jobId, at, leaseUntil],
      );
      const row = updated.rows[0];
      if (!row) return undefined;
      await this.audit(client, row.team_id, null, "code_task.running", "code_task", row.id, { jobId });
      return this.toCodeTask(row);
    });
  }

  async assertCodeTaskCapability(jobId: string, rawCapability: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(rawCapability)) throw new HttpError(401, "Invalid or expired executor capability");
    const result = await this.store.pool.query<{ id: string }>(
      `SELECT id FROM team_code_tasks WHERE executor_job_id=$1 AND executor_capability_hash=$2
         AND status IN ('dispatching','running') AND executor_lease_until>$3`,
      [jobId, digest(rawCapability), new Date(this.now())],
    );
    if (!result.rows[0]) throw new HttpError(401, "Invalid or expired executor capability");
  }

  async heartbeatCodeTask(jobId: string, sequence: number, sentAt: number): Promise<{ status: TeamCodeTaskStatus; shouldStop: boolean; leaseExpiresAt?: string }> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new HttpError(400, "Executor heartbeat sequence must be a positive safe integer");
    const now = this.now();
    if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > EXECUTOR_HEARTBEAT_WINDOW_MS) throw new HttpError(400, "Executor heartbeat timestamp is outside the accepted window");
    return this.store.transaction(async (client) => {
      const result = await client.query<CodeTaskRow>(
        `SELECT id, team_id, status, executor_lease_until, executor_heartbeat_seq FROM team_code_tasks WHERE executor_job_id=$1 FOR UPDATE`, [jobId],
      );
      const task = result.rows[0];
      if (!task) throw new HttpError(404, "Executor job not found");
      if (task.status !== "dispatching" && task.status !== "running") return { status: task.status, shouldStop: true };
      const currentLease = task.executor_lease_until == null ? NaN : new Date(task.executor_lease_until).getTime();
      if (!Number.isFinite(currentLease) || currentLease <= now) {
        if (task.status === "running") {
          await client.query(
            `UPDATE team_code_tasks SET status='failed', executor_error='executor_lease_expired', executor_lease_until=NULL, executor_capability_hash=NULL, executor_capability_encrypted=NULL, executor_finished_at=$2, updated_at=$2
              WHERE id=$1 AND status='running'`, [task.id, new Date(now)],
          );
          await this.audit(client, task.team_id, null, "code_task.failed", "code_task", task.id, { error: "executor_lease_expired" });
          return { status: "failed", shouldStop: true };
        }
        return { status: task.status, shouldStop: true };
      }
      const currentSequence = Number(task.executor_heartbeat_seq ?? 0);
      if (sequence <= currentSequence) return { status: task.status, shouldStop: false, leaseExpiresAt: new Date(currentLease).toISOString() };
      const leaseUntil = new Date(now + EXECUTOR_RUNNING_LEASE_MS);
      await client.query(
        `UPDATE team_code_tasks SET executor_heartbeat_seq=$2, executor_lease_until=$3, updated_at=$4
          WHERE id=$1 AND status IN ('dispatching','running') AND executor_heartbeat_seq < $2`,
        [task.id, sequence, leaseUntil, new Date(now)],
      );
      return { status: task.status, shouldStop: false, leaseExpiresAt: leaseUntil.toISOString() };
    });
  }

  async markCodeTaskDispatchFailed(jobId: string, rawError: unknown): Promise<TeamCodeTask | undefined> {
    const error = boundedExecutorText(rawError, 4_000, "executor dispatch failed");
    return this.store.transaction(async (client) => {
      const at = new Date(this.now());
      const updated = await client.query<CodeTaskRow>(
        `UPDATE team_code_tasks SET status=CASE WHEN executor_attempts >= 3 THEN 'failed' ELSE 'approved_waiting_executor' END,
                executor_error=$2, executor_lease_until=NULL,
                executor_capability_hash=CASE WHEN executor_attempts >= 3 THEN NULL ELSE executor_capability_hash END,
                executor_capability_encrypted=CASE WHEN executor_attempts >= 3 THEN NULL ELSE executor_capability_encrypted END,
                executor_finished_at=CASE WHEN executor_attempts >= 3 THEN $3 ELSE NULL END, updated_at=$3
          WHERE executor_job_id=$1 AND status='dispatching'
          RETURNING id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at,
                    executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at`,
        [jobId, error, at],
      );
      const row = updated.rows[0];
      if (!row) return undefined;
      await this.audit(client, row.team_id, null, row.status === "failed" ? "code_task.failed" : "code_task.dispatch_retry", "code_task", row.id, { jobId, error });
      return this.toCodeTask(row);
    });
  }

  /**
   * 探测代码托管方的真实默认分支。
   *
   * 之前默认分支硬编码为 "main"，但大量仓库（尤其老仓库）默认分支是 "master"，
   * 会导致代码任务在取快照时 502。
   *
   * 探测顺序：
   *  1) git smart-HTTP 的 info/refs 响应里带 `symref=HEAD:refs/heads/<branch>`，
   *     不消耗 REST API 配额，公开仓库无需凭据，是首选方式；
   *  2) REST API（私有仓库 / git 协议不可用时兜底，可能吃到速率限制）；
   *  3) 都失败则回落到 "main"，不阻断建项目流程。
   */
  private async detectDefaultBranch(provider: TeamProject["provider"], repositoryUrl: string): Promise<string> {
    const repoParts = new URL(repositoryUrl).pathname.split("/").filter(Boolean);
    if (repoParts.length < 2) return "main";
    const encodedPath = repoParts.map(encodeURIComponent).join("/");

    // 1) git smart-HTTP：直接问托管方 HEAD 指向哪个分支
    const smartHttp = await this.detectBranchViaSmartHttp(provider, repositoryUrl);
    if (smartHttp) return smartHttp;

    // 2) REST API 兜底
    const url = provider === "github"
      ? new URL(`/repos/${encodedPath}`, "https://api.github.com")
      : new URL(`/api/v4/projects/${encodeURIComponent(repoParts.join("/"))}`, "https://gitlab.com");
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: { accept: provider === "github" ? "application/vnd.github+json" : "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return "main";
      }
      const payload = await response.json() as { default_branch?: unknown };
      return this.sanitizeDetectedBranch(payload.default_branch);
    } catch {
      return "main";
    }
  }

  /** git smart-HTTP 探测：info/refs 响应首行含 `symref=HEAD:refs/heads/<branch>` */
  private async detectBranchViaSmartHttp(
    provider: TeamProject["provider"],
    repositoryUrl: string,
  ): Promise<string | undefined> {
    // 注意：不能用 new URL("/info/refs", base) —— 那会把仓库路径整个替换掉，
    // 必须挂在 <repo>.git 之后。
    const url = new URL(`${repositoryUrl}.git/info/refs?service=git-upload-pack`);
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: { accept: "application/x-git-upload-pack-advertisement", "user-agent": "dazuibot-team" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const text = await response.text();
      const match = /symref=HEAD:refs\/heads\/([^\s\x00]+)/.exec(text);
      if (!match) return undefined;
      return this.sanitizeDetectedBranch(match[1]);
    } catch {
      void provider;
      return undefined;
    }
  }

  /** 校验托管方返回的分支名，非法就回落 main */
  private sanitizeDetectedBranch(raw: unknown): string {
    const branch = typeof raw === "string" ? raw.trim() : "";
    if (!branch || branch.length > 120) return "main";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch)) return "main";
    if (branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) return "main";
    return branch;
  }

  async getCodeTaskSnapshot(jobId: string, rawCapability: string): Promise<CodeTaskSnapshot> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(rawCapability)) throw new HttpError(401, "Invalid executor capability");
    const result = await this.store.pool.query<{
      provider: TeamProject["provider"];
      repository_url: string;
      default_branch: string;
      encrypted_token: string | null;
    }>(
      `SELECT p.provider, p.repository_url, p.default_branch, g.encrypted_token
         FROM team_code_tasks t
         JOIN team_projects p ON p.id=t.project_id AND p.team_id=t.team_id
         JOIN team_memberships m ON m.team_id=t.team_id AND m.user_id=t.created_by AND m.role IN ('owner','admin','developer')
         LEFT JOIN team_git_credentials g ON g.team_id=t.team_id AND g.provider=p.provider
        WHERE t.executor_job_id=$1 AND t.executor_capability_hash=$2 AND t.status='running' AND t.executor_lease_until>$3`,
      [jobId, digest(rawCapability), new Date(this.now())],
    );
    const project = result.rows[0];
    if (!project) throw new HttpError(401, "Invalid or expired executor capability");

    const repoParts = new URL(project.repository_url).pathname.split("/").filter(Boolean);
    const archiveUrl = project.provider === "github"
      ? new URL(`/repos/${repoParts.map(encodeURIComponent).join("/")}/tarball/${encodeURIComponent(project.default_branch)}`, "https://api.github.com")
      : new URL(`/api/v4/projects/${encodeURIComponent(repoParts.join("/"))}/repository/archive.tar.gz?sha=${encodeURIComponent(project.default_branch)}`, "https://gitlab.com");
    let headers: Record<string, string> = { accept: project.provider === "github" ? "application/vnd.github+json" : "application/octet-stream" };
    if (project.encrypted_token) {
      try {
        const token = decryptCredential(this.config.credentialSecret, project.encrypted_token);
        headers = project.provider === "github" ? { ...headers, authorization: `Bearer ${token}` } : { ...headers, "private-token": token };
      } catch {
        throw new HttpError(503, "The team repository credential is unavailable");
      }
    }

    let response: Response;
    try {
      response = await this.fetcher(archiveUrl, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new HttpError(502, "The code host returned an invalid repository archive redirect");
        const target = new URL(location, archiveUrl);
        const allowedHost = project.provider === "github"
          ? target.hostname === "codeload.github.com"
          : target.hostname === "gitlab.com" || target.hostname === "storage.googleapis.com";
        if (target.protocol !== "https:" || target.username || target.password || !allowedHost) {
          throw new HttpError(502, "The code host returned an unsafe repository archive redirect");
        }
        response = await this.fetcher(target, { method: "GET", headers: { accept: "application/octet-stream" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "Could not fetch the registered repository snapshot");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(502, "Could not fetch the registered repository snapshot; check repository visibility and team read access");
    }
    const archive = await boundedBytes(response, CODE_TASK_SNAPSHOT_MAX_BYTES, "The repository snapshot exceeds the 50 MiB task limit");
    if (!archive.byteLength) throw new HttpError(502, "The code host returned an empty repository snapshot");
    return { archive, contentType: "application/gzip" };
  }

  async proxyCodeTaskModel(jobId: string, rawCapability: string, rawBody: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(rawCapability)) throw new HttpError(401, "Invalid executor capability");
    if (!this.config.modelBaseUrl) throw new HttpError(503, "The team model endpoint is not configured");
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody) || !Array.isArray(rawBody.messages) || rawBody.messages.length < 1 || rawBody.messages.length > 200) {
      throw new HttpError(400, "Executor model request must include between 1 and 200 messages");
    }
    if (rawBody.stream !== undefined && typeof rawBody.stream !== "boolean") throw new HttpError(400, "Executor stream must be a boolean");
    if (rawBody.n !== undefined && rawBody.n !== 1) throw new HttpError(400, "Executor model requests may ask for one completion at a time");
    if (rawBody.max_tokens !== undefined && (typeof rawBody.max_tokens !== "number" || !Number.isSafeInteger(rawBody.max_tokens) || rawBody.max_tokens < 1)) throw new HttpError(400, "Executor completion token limit is invalid");
    if (rawBody.max_completion_tokens !== undefined && (typeof rawBody.max_completion_tokens !== "number" || !Number.isSafeInteger(rawBody.max_completion_tokens) || rawBody.max_completion_tokens < 1)) throw new HttpError(400, "Executor completion token limit is invalid");
    if (rawBody.max_tokens !== undefined && rawBody.max_completion_tokens !== undefined) throw new HttpError(400, "Use only one completion token limit");
    const requestBytes = Buffer.byteLength(JSON.stringify(rawBody), "utf8");
    if (requestBytes > CODE_TASK_MODEL_REQUEST_MAX_BYTES) throw new HttpError(413, "Executor model request is too large");

    const credential = await this.store.transaction(async (client) => {
      const locked = await client.query<{ team_id: string; model: string; encrypted_api_key: string; request_count: number }>(
        `SELECT t.team_id, COALESCE(t.executor_model, c.model) AS model, c.encrypted_api_key, t.executor_model_requests AS request_count
           FROM team_code_tasks t
           JOIN team_memberships m ON m.team_id=t.team_id AND m.user_id=t.created_by AND m.role IN ('owner','admin','developer')
           JOIN team_model_credentials c ON c.team_id=t.team_id
          WHERE t.executor_job_id=$1 AND t.executor_capability_hash=$2 AND t.status='running' AND t.executor_lease_until>$3
          FOR UPDATE OF t`, [jobId, digest(rawCapability), new Date(this.now())],
      );
      const row = locked.rows[0];
      if (!row) {
        throw new HttpError(401, "Invalid or expired executor capability");
      }
      if (rawBody.model !== undefined && rawBody.model !== row.model) throw new HttpError(400, "Executor model does not match the configured team model");
      if (row.request_count >= 200) throw new HttpError(429, "This code task reached its 200-request model limit");
      const updated = await client.query(
        `UPDATE team_code_tasks SET executor_model_requests=executor_model_requests+1
          WHERE executor_job_id=$1 AND executor_capability_hash=$2 AND status='running' AND executor_lease_until>$3
          RETURNING id`,
        [jobId, digest(rawCapability), new Date(this.now())],
      );
      if (!updated.rowCount) throw new HttpError(401, "Invalid or expired executor capability");
      return row;
    });

    let apiKey: string;
    try { apiKey = decryptCredential(this.config.credentialSecret, credential.encrypted_api_key); }
    catch { throw new HttpError(503, "The team model credential is unavailable"); }
    const forwardedBody: Record<string, unknown> = { ...rawBody, model: credential.model, n: 1 };
    if (typeof forwardedBody.max_completion_tokens === "number") {
      forwardedBody.max_completion_tokens = Math.min(forwardedBody.max_completion_tokens, CODE_TASK_MODEL_MAX_TOKENS);
    } else {
      const requested = forwardedBody.max_tokens;
      forwardedBody.max_tokens = typeof requested === "number" ? Math.min(requested, CODE_TASK_MODEL_MAX_TOKENS) : CODE_TASK_MODEL_MAX_TOKENS;
    }

    let response: Response;
    try {
      response = await this.fetcher(`${this.config.modelBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(forwardedBody),
        signal: AbortSignal.any([signal, AbortSignal.timeout(CODE_TASK_MODEL_TIMEOUT_MS)].filter((item): item is AbortSignal => item !== undefined)),
        redirect: "error",
      });
    } catch {
      throw new HttpError(502, "The team model service is unavailable");
    }
    const advertised = Number(response.headers.get("content-length") ?? 0);
    if (advertised > CODE_TASK_MODEL_RESPONSE_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(502, "The team model response exceeds the 10 MiB task limit");
    }
    return response;
  }

  async completeCodeTask(jobId: string, outcome: "succeeded" | "failed", rawResult: unknown, rawError: unknown): Promise<TeamCodeTask> {
    const result = boundedExecutorText(rawResult, 20_000, "");
    const error = rawError == null || rawError === "" ? "" : boundedExecutorText(rawError, 4_000, "executor failed");
    return this.store.transaction(async (client) => {
      const existing = await client.query<CodeTaskRow>(
        `SELECT id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at,
                executor_job_id, executor_attempts, executor_lease_until, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at
           FROM team_code_tasks WHERE executor_job_id=$1 FOR UPDATE`, [jobId],
      );
      const task = existing.rows[0];
      if (!task) throw new HttpError(404, "Executor job not found");
      if (task.status === "cancelled" || task.status === "succeeded" || task.status === "failed") return this.toCodeTask(task);
      if (task.status !== "running") throw new HttpError(409, "Executor job is not running");
      const at = new Date(this.now());
      if (!task.executor_lease_until || new Date(task.executor_lease_until).getTime() <= at.getTime()) {
        const expired = await client.query<CodeTaskRow>(
          `UPDATE team_code_tasks SET status='failed', executor_error='executor_lease_expired', executor_lease_until=NULL, executor_capability_hash=NULL, executor_capability_encrypted=NULL, executor_finished_at=$2, updated_at=$2
            WHERE executor_job_id=$1 AND status='running'
            RETURNING id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at,
                      executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at`,
          [jobId, at],
        );
        const row = expired.rows[0];
        if (!row) throw new HttpError(409, "Executor job is no longer running");
        await this.audit(client, row.team_id, null, "code_task.failed", "code_task", row.id, { error: "executor_lease_expired" });
        return this.toCodeTask(row);
      }
      const updated = await client.query<CodeTaskRow>(
        `UPDATE team_code_tasks SET status=$2, executor_result=$3, executor_error=$4, executor_lease_until=NULL,
             executor_capability_hash=NULL, executor_capability_encrypted=NULL, executor_finished_at=$5, updated_at=$5
          WHERE executor_job_id=$1 AND status='running'
          RETURNING id, team_id, project_id, created_by, branch, instructions, status, decision_reason, decided_by, decided_at,
                    executor_job_id, executor_attempts, executor_started_at, executor_finished_at, executor_result, executor_error, created_at, updated_at`,
        [jobId, outcome, result || null, error || null, at],
      );
      const row = updated.rows[0];
      if (!row) throw new HttpError(409, "Executor job is no longer running");
      await this.audit(client, row.team_id, null, `code_task.${outcome}`, "code_task", row.id, { jobId, result: result || undefined, error: error || undefined });
      return this.toCodeTask(row);
    });
  }

  async getGitCredentialStatus(principal: Principal, teamId: string): Promise<GitCredentialStatus> {
    const role = await this.requireMembership(principal, teamId);
    const result = await this.store.pool.query<{ provider: "github" | "gitlab"; key_tail: string }>(
      "SELECT provider, key_tail FROM team_git_credentials WHERE team_id=$1", [teamId],
    );
    const status: GitCredentialStatus = { github: { configured: false }, gitlab: { configured: false } };
    for (const row of result.rows) status[row.provider] = {
      configured: true,
      ...((role === "owner" || role === "admin") ? { keyTail: row.key_tail } : {}),
    };
    return status;
  }

  async saveGitCredential(principal: Principal, teamId: string, provider: unknown, rawToken: unknown): Promise<GitCredentialStatus> {
    if (provider !== "github" && provider !== "gitlab") throw new HttpError(400, "Choose GitHub or GitLab");
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!token || token.length > 4096 || /[\r\n\0]/.test(token)) throw new HttpError(400, "Enter a valid access token");
    const encrypted = encryptCredential(this.config.credentialSecret, token);
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      await client.query(
        `INSERT INTO team_git_credentials(team_id, provider, encrypted_token, key_tail, updated_by, updated_at)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(team_id, provider) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,
           key_tail=EXCLUDED.key_tail, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [teamId, provider, encrypted, credentialTail(token), principal.userId, new Date(this.now())],
      );
      await this.audit(client, teamId, principal.userId, "git_credentials.updated", "git_credentials", provider, {});
    });
    return this.getGitCredentialStatus(principal, teamId);
  }

  async deleteGitCredential(principal: Principal, teamId: string, provider: unknown): Promise<void> {
    if (provider !== "github" && provider !== "gitlab") throw new HttpError(400, "Choose GitHub or GitLab");
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      await client.query("DELETE FROM team_git_credentials WHERE team_id=$1 AND provider=$2", [teamId, provider]);
      await this.audit(client, teamId, principal.userId, "git_credentials.deleted", "git_credentials", provider, {});
    });
  }

  async createProjectReview(principal: Principal, teamId: string, projectId: string, input: { head?: unknown; title?: unknown; body?: unknown }): Promise<TeamReview> {
    const role = await this.requireMembership(principal, teamId);
    if (role === "viewer") throw new HttpError(403, "Your team role cannot create code reviews");
    const project = await this.getProject(principal, teamId, projectId);
    const head = typeof input.head === "string" ? input.head.trim() : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(head) || head.includes("..") || head.includes("//") || head.endsWith("/") || head.endsWith(".")) throw new HttpError(400, "Enter a valid pushed source branch");
    if (!title || title.length > 240) throw new HttpError(400, "Review title must be between 1 and 240 characters");
    if (body.length > 20_000) throw new HttpError(400, "Review description must be at most 20000 characters");
    const credential = await this.store.pool.query<{ encrypted_token: string }>(
      "SELECT encrypted_token FROM team_git_credentials WHERE team_id=$1 AND provider=$2", [teamId, project.provider],
    );
    const encrypted = credential.rows[0]?.encrypted_token;
    if (!encrypted) throw new HttpError(409, `A team ${project.provider === "github" ? "GitHub" : "GitLab"} access token is not configured`);
    const token = this.decryptApiKey(encrypted);
    const parts = new URL(project.repositoryUrl).pathname.split("/").filter(Boolean);
    const url = project.provider === "github"
      ? `https://api.github.com/repos/${parts.map(encodeURIComponent).join("/")}/pulls`
      : `https://gitlab.com/api/v4/projects/${encodeURIComponent(parts.join("/"))}/merge_requests`;
    const payload = project.provider === "github"
      ? { title, body, head, base: project.defaultBranch }
      : { title, description: body, source_branch: head, target_branch: project.defaultBranch };
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: project.provider === "github"
          ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" }
          : { "private-token": token, "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, `Could not reach ${project.provider === "github" ? "GitHub" : "GitLab"}`);
    }
    const text = await response.text().catch(() => "");
    if (text.length > 32_768) throw new HttpError(502, "Code host returned an oversized response");
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(text) as Record<string, unknown>; } catch { /* handled as an upstream error below */ }
    if (!response.ok) {
      const message = typeof result.message === "string" ? result.message : typeof result.error === "string" ? result.error : "request rejected";
      if (response.status === 401 || response.status === 403) throw new HttpError(502, "Code host rejected the configured access token or repository permissions");
      if (response.status === 409 || response.status === 422) throw new HttpError(409, "Code host could not create this review; check that the branch is pushed and a review does not already exist");
      console.warn("team code review request rejected", { provider: project.provider, status: response.status, message: message.slice(0, 180) });
      throw new HttpError(502, `Code host returned HTTP ${response.status}`);
    }
    const reviewUrl = project.provider === "github" ? result.html_url : result.web_url;
    let validReviewUrl = false;
    if (typeof reviewUrl === "string") {
      try {
        const repository = new URL(project.repositoryUrl);
        const review = new URL(reviewUrl);
        validReviewUrl = review.origin === repository.origin && review.pathname.startsWith(`${repository.pathname}/`);
      } catch { /* malformed upstream URL */ }
    }
    if (typeof reviewUrl !== "string" || !validReviewUrl) throw new HttpError(502, "Code host returned an invalid review URL");
    const review: TeamReview = {
      url: reviewUrl,
      ...(typeof result.number === "number" ? { number: result.number } : typeof result.iid === "number" ? { number: result.iid } : {}),
      title,
      ...(typeof result.state === "string" ? { state: result.state } : {}),
    };
    await this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin", "developer"]));
      await this.audit(client, teamId, principal.userId, "project.review_created", "project", projectId, { provider: project.provider, head, base: project.defaultBranch, url: review.url });
    });
    return review;
  }

  async getProjectDiff(principal: Principal, teamId: string, projectId: string, rawHead: unknown): Promise<TeamProjectDiff> {
    const role = await this.requireMembership(principal, teamId);
    if (role === "viewer") throw new HttpError(403, "Your team role cannot view code review details");
    const project = await this.getProject(principal, teamId, projectId);
    const head = typeof rawHead === "string" ? rawHead.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(head) || head.includes("..") || head.includes("//") || head.endsWith("/") || head.endsWith(".")) throw new HttpError(400, "Enter a valid pushed source branch");
    const credential = await this.store.pool.query<{ encrypted_token: string }>(
      "SELECT encrypted_token FROM team_git_credentials WHERE team_id=$1 AND provider=$2", [teamId, project.provider],
    );
    const encrypted = credential.rows[0]?.encrypted_token;
    if (!encrypted) throw new HttpError(409, `A team ${project.provider === "github" ? "GitHub" : "GitLab"} access token is not configured`);
    const token = this.decryptApiKey(encrypted);
    const parts = new URL(project.repositoryUrl).pathname.split("/").filter(Boolean);
    let url: string;
    const headers: Record<string, string> = project.provider === "github"
      ? { authorization: `Bearer ${token}`, accept: "application/vnd.github.diff", "x-github-api-version": "2022-11-28" }
      : { "private-token": token, accept: "application/json" };
    if (project.provider === "github") {
      url = `https://api.github.com/repos/${parts.map(encodeURIComponent).join("/")}/compare/${encodeURIComponent(project.defaultBranch)}...${encodeURIComponent(head)}`;
    } else {
      const endpoint = new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(parts.join("/"))}/repository/compare`);
      endpoint.searchParams.set("from", project.defaultBranch);
      endpoint.searchParams.set("to", head);
      endpoint.searchParams.set("straight", "true");
      url = endpoint.toString();
    }
    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new HttpError(502, `Could not reach ${project.provider === "github" ? "GitHub" : "GitLab"}`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new HttpError(502, "Code host rejected the configured access token or repository permissions");
      if (response.status === 404) throw new HttpError(404, "Branch or repository was not found on the code host");
      throw new HttpError(502, `Code host returned HTTP ${response.status}`);
    }
    const limit = 256 * 1024;
    let diff = "";
    let truncated = false;
    if (project.provider === "github") {
      const text = await readBoundedText(response, limit);
      diff = text.text;
      truncated = text.truncated;
    } else {
      const bounded = await readBoundedText(response, 2 * 1024 * 1024);
      if (bounded.truncated) throw new HttpError(502, "Code host returned an oversized comparison");
      let result: { diffs?: Array<{ old_path?: unknown; new_path?: unknown; diff?: unknown }> };
      try { result = JSON.parse(bounded.text) as typeof result; } catch { throw new HttpError(502, "Code host returned an invalid comparison"); }
      for (const file of result.diffs ?? []) {
        const section = `diff -- ${String(file.old_path ?? "")} -> ${String(file.new_path ?? "")}\n${typeof file.diff === "string" ? file.diff : ""}\n`;
        if (Buffer.byteLength(diff) + Buffer.byteLength(section) > limit) { truncated = true; break; }
        diff += section;
      }
    }
    return { head, base: project.defaultBranch, diff, truncated };
  }

  async listBots(principal: Principal, teamId: string): Promise<TeamBot[]> {
    const result = await this.store.pool.query<TeamBotRow>(
      `SELECT b.id, b.team_id, b.name, b.description, b.instructions, b.created_by, b.created_at, b.updated_at
         FROM team_bots b JOIN team_memberships m ON m.team_id=b.team_id AND m.user_id=$2
        WHERE b.team_id=$1 ORDER BY b.created_at, b.id`, [teamId, principal.userId],
    );
    return result.rows.map((row) => this.toTeamBot(row));
  }

  async createBot(principal: Principal, teamId: string, input: { name?: unknown; description?: unknown; instructions?: unknown }): Promise<TeamBot> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description = typeof input.description === "string" ? input.description.trim() : "";
    const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
    if (name.length < 1 || name.length > 80) throw new HttpError(400, "Bot name must be between 1 and 80 characters");
    if (description.length > 4000) throw new HttpError(400, "Bot description must be at most 4000 characters");
    if (instructions.length > 12000) throw new HttpError(400, "Bot instructions must be at most 12000 characters");
    const botId = id();
    return this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin"]));
      const result = await client.query<TeamBotRow>(
        `INSERT INTO team_bots(id, team_id, name, description, instructions, created_by, created_at, updated_at)
         SELECT $1, t.id, $3, $4, $5, $6, $7, $7 FROM teams t WHERE t.id=$2
         RETURNING id, team_id, name, description, instructions, created_by, created_at, updated_at`,
        [botId, teamId, name, description, instructions, principal.userId, new Date(this.now())],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "Team not found");
      await this.audit(client, teamId, principal.userId, "bot.created", "bot", botId, { name });
      return this.toTeamBot(row);
    });
  }

  async listConversations(principal: Principal, teamId: string): Promise<TeamConversation[]> {
    const result = await this.store.pool.query<ConversationRow>(
      `SELECT c.id, c.team_id, c.bot_id, b.name AS bot_name, c.title, c.visibility, c.created_by, c.created_at, c.updated_at
         FROM team_conversations c JOIN team_bots b ON b.team_id=c.team_id AND b.id=c.bot_id
         JOIN team_memberships m ON m.team_id=c.team_id AND m.user_id=$2
        WHERE c.team_id=$1 AND (c.visibility='team' OR c.created_by=$2)
        ORDER BY c.updated_at DESC, c.id`, [teamId, principal.userId],
    );
    return result.rows.map((row) => this.toConversation(row));
  }

  async createConversation(principal: Principal, teamId: string, input: { botId?: unknown; title?: unknown; visibility?: unknown }): Promise<TeamConversation> {
    const botId = typeof input.botId === "string" ? input.botId.trim() : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const visibility = input.visibility === "private" ? "private" : input.visibility === "team" ? "team" : "";
    if (!botId) throw new HttpError(400, "Choose a team bot");
    if (title.length < 1 || title.length > 120) throw new HttpError(400, "Conversation title must be between 1 and 120 characters");
    if (!visibility) throw new HttpError(400, "Choose team or private visibility");
    const conversationId = id();
    return this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin", "developer"]));
      const result = await client.query<ConversationRow>(
        `INSERT INTO team_conversations(id, team_id, bot_id, title, visibility, created_by, created_at, updated_at)
         SELECT $1, b.team_id, b.id, $4, $5, $6, $7, $7 FROM team_bots b WHERE b.team_id=$2 AND b.id=$3
         RETURNING id, team_id, bot_id, (SELECT name FROM team_bots WHERE id=bot_id) AS bot_name,
                   title, visibility, created_by, created_at, updated_at`,
        [conversationId, teamId, botId, title, visibility, principal.userId, new Date(this.now())],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "Team bot not found");
      await this.audit(client, teamId, principal.userId, "conversation.created", "conversation", conversationId, { botId, visibility });
      return this.toConversation(row);
    });
  }

  async listMessages(principal: Principal, teamId: string, conversationId: string): Promise<TeamMessage[]> {
    const conversation = await this.requireConversation(principal, teamId, conversationId);
    const result = await this.store.pool.query<MessageRow>(
      `SELECT id, conversation_id, author_user_id, author_email, role, content, created_at FROM (
         SELECT msg.id, msg.conversation_id, msg.author_user_id, COALESCE(u.email, 'Dazuibot AI') AS author_email, msg.role, msg.content, msg.created_at, msg.sequence AS ordering
           FROM team_messages msg LEFT JOIN team_users u ON u.id=msg.author_user_id
           JOIN team_conversations c ON c.id=msg.conversation_id
           JOIN team_memberships m ON m.team_id=c.team_id AND m.user_id=$3
          WHERE msg.conversation_id=$1 AND c.team_id=$2 AND (c.visibility='team' OR c.created_by=$3)
          ORDER BY msg.sequence DESC LIMIT 200
       ) recent ORDER BY ordering`, [conversation.id, teamId, principal.userId],
    );
    return result.rows.map((row) => this.toMessage(row));
  }

  async assertConversationAccess(principal: Principal, teamId: string, conversationId: string): Promise<void> {
    await this.requireConversation(principal, teamId, conversationId);
  }

  async postMessage(principal: Principal, teamId: string, conversationId: string, rawContent: unknown): Promise<PostTeamMessageResult> {
    const content = typeof rawContent === "string" ? rawContent.trim() : "";
    if (!content || content.length > 20_000) throw new HttpError(400, "Message must be between 1 and 20000 characters");
    const messageId = id();
    return this.store.transaction(async (client) => {
      await this.requireRoleIn(client, principal, teamId, new Set(["owner", "admin", "developer"]));
      const allowedConversation = await client.query(
        `SELECT 1 FROM team_conversations c JOIN team_memberships m ON m.team_id=c.team_id AND m.user_id=$3
          WHERE c.id=$1 AND c.team_id=$2 AND (c.visibility='team' OR c.created_by=$3)`, [conversationId, teamId, principal.userId],
      );
      if (!allowedConversation.rowCount) throw new HttpError(404, "Conversation not found");
      const modelConfig = await client.query<{ model: string }>("SELECT model FROM team_model_credentials WHERE team_id=$1", [teamId]);
      if (!modelConfig.rowCount) throw new HttpError(409, "The team model is not configured");
      // 成员实际使用的模型：成员在授权范围内的自主选择，落在范围外时回落到团队默认模型
      const resolvedModel = await this.resolveModelForMemberIn(client, teamId, principal.userId, modelConfig.rows[0]!.model);
      if (!resolvedModel) throw new HttpError(409, "No model is available to you under the team model policy");
      const result = await client.query<{ id: string }>(
        `INSERT INTO team_messages(id, conversation_id, author_user_id, role, content, created_at)
         SELECT $1, c.id, $3, 'user', $4, $5 FROM team_conversations c
           JOIN team_memberships m ON m.team_id=c.team_id AND m.user_id=$3 AND m.role IN ('owner','admin','developer')
          WHERE c.id=$2 AND c.team_id=$6 AND (c.visibility='team' OR c.created_by=$3)
         RETURNING id`, [messageId, conversationId, principal.userId, content, new Date(this.now()), teamId],
      );
      if (!result.rows[0]) throw new HttpError(404, "Conversation not found");
      await client.query("UPDATE team_conversations SET updated_at=$2 WHERE id=$1", [conversationId, new Date(this.now())]);
      const jobId = id();
      const at = new Date(this.now());
      // available_at 用表上的默认值（数据库时钟）。worker 判断是否可取用时也用数据库时钟
      // （clock_timestamp()），两边同源；混用应用时钟会因为网络往返产生的约 1ms 差距
      // 把同一时刻入队的任务判为"尚未到期"。退避重试会改写成应用时钟，那是另一条路径。
      await client.query("INSERT INTO team_jobs(id, team_id, conversation_id, user_message_id, created_by, created_at, updated_at, model_name) VALUES($1,$2,$3,$4,$5,$6,$6,$7)",
        [jobId, teamId, conversationId, messageId, principal.userId, at, resolvedModel]);
      await this.audit(client, teamId, principal.userId, "job.queued", "job", jobId, { conversationId, messageId });
      const message = await client.query<MessageRow>(
        `SELECT msg.id, msg.conversation_id, msg.author_user_id, u.email AS author_email, msg.role, msg.content, msg.created_at
           FROM team_messages msg JOIN team_users u ON u.id=msg.author_user_id WHERE msg.id=$1`, [messageId],
      );
      const row = message.rows[0];
      if (!row) throw new Error("Could not load the posted team message");
      const jobAt = this.iso(at);
      return { message: this.toMessage(row), job: { id: jobId, conversationId, status: "queued", attemptCount: 0, createdAt: jobAt, updatedAt: jobAt } };
    });
  }

  async listJobs(principal: Principal, teamId: string, conversationId: string): Promise<TeamJob[]> {
    const result = await this.store.pool.query<JobRow>(
      `SELECT j.id, j.conversation_id, j.status, j.attempt_count, j.error_code, j.created_at, j.updated_at
         FROM team_jobs j JOIN team_conversations c ON c.team_id=j.team_id AND c.id=j.conversation_id
         JOIN team_memberships m ON m.team_id=j.team_id AND m.user_id=$3
        WHERE j.team_id=$1 AND j.conversation_id=$2 AND (c.visibility='team' OR c.created_by=$3)
        ORDER BY j.created_at DESC, j.id DESC LIMIT 30`, [teamId, conversationId, principal.userId],
    );
    return result.rows.map((row) => this.toJob(row));
  }

  async getUsage(principal: Principal, teamId: string): Promise<TeamUsage> {
    const role = await this.requireMembership(principal, teamId);
    const allMembers = role === "owner" || role === "admin";
    const now = this.now();
    const periodStart = new Date(now - 30 * 24 * 60 * 60_000);
    const result = await this.store.pool.query<UsageRow>(
      `SELECT j.created_by AS user_id, u.email,
              COUNT(*) FILTER (WHERE j.status='succeeded')::text AS successful_jobs,
              COUNT(*) FILTER (WHERE j.status='succeeded' AND j.prompt_tokens IS NOT NULL AND j.completion_tokens IS NOT NULL)::text AS reported_jobs,
              COALESCE(SUM(j.prompt_tokens) FILTER (WHERE j.status='succeeded'), 0)::text AS input_tokens,
              COALESCE(SUM(j.completion_tokens) FILTER (WHERE j.status='succeeded'), 0)::text AS output_tokens
         FROM team_jobs j JOIN team_users u ON u.id=j.created_by
        WHERE j.team_id=$1 AND j.created_at >= $3 AND j.created_at <= $4 AND ($5::boolean OR j.created_by=$2)
        GROUP BY j.created_by, u.email ORDER BY u.email, j.created_by`,
      [teamId, principal.userId, periodStart, new Date(now), allMembers],
    );
    const members: TeamUsageMember[] = result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      successfulJobs: safeCount(row.successful_jobs),
      reportedJobs: safeCount(row.reported_jobs),
      inputTokens: safeCount(row.input_tokens),
      outputTokens: safeCount(row.output_tokens),
    }));
    return {
      scope: allMembers ? "team" : "member",
      periodStart: periodStart.toISOString(),
      successfulJobs: members.reduce((sum, item) => sum + item.successfulJobs, 0),
      reportedJobs: members.reduce((sum, item) => sum + item.reportedJobs, 0),
      inputTokens: members.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: members.reduce((sum, item) => sum + item.outputTokens, 0),
      members,
    };
  }

  private async requireConversation(principal: Principal, teamId: string, conversationId: string): Promise<ConversationRow> {
    const result = await this.store.pool.query<ConversationRow>(
      `SELECT c.id, c.team_id, c.bot_id, b.name AS bot_name, c.title, c.visibility, c.created_by, c.created_at, c.updated_at
         FROM team_conversations c JOIN team_bots b ON b.team_id=c.team_id AND b.id=c.bot_id
         JOIN team_memberships m ON m.team_id=c.team_id AND m.user_id=$3
        WHERE c.team_id=$1 AND c.id=$2 AND (c.visibility='team' OR c.created_by=$3)`, [teamId, conversationId, principal.userId],
    );
    const conversation = result.rows[0];
    if (!conversation) throw new HttpError(404, "Conversation not found");
    return conversation;
  }

  private toTeamBot(row: TeamBotRow): TeamBot {
    return { id: row.id, teamId: row.team_id, name: row.name, description: row.description, instructions: row.instructions,
      createdBy: row.created_by, createdAt: this.iso(row.created_at), updatedAt: this.iso(row.updated_at) };
  }

  private toConversation(row: ConversationRow): TeamConversation {
    return { id: row.id, teamId: row.team_id, botId: row.bot_id, botName: row.bot_name, title: row.title, visibility: row.visibility,
      createdBy: row.created_by, createdAt: this.iso(row.created_at), updatedAt: this.iso(row.updated_at) };
  }

  private toMessage(row: MessageRow): TeamMessage {
    return { id: row.id, conversationId: row.conversation_id, authorUserId: row.author_user_id, authorEmail: row.author_email,
      role: row.role, content: row.content, createdAt: this.iso(row.created_at) };
  }

  private toJob(row: JobRow): TeamJob {
    return { id: row.id, conversationId: row.conversation_id, status: row.status, attemptCount: Number(row.attempt_count),
      ...(row.error_code ? { errorCode: row.error_code } : {}), createdAt: this.iso(row.created_at), updatedAt: this.iso(row.updated_at) };
  }

  private toProject(row: ProjectRow): TeamProject {
    return { id: row.id, teamId: row.team_id, name: row.name, provider: row.provider, repositoryUrl: row.repository_url,
      cloneUrl: row.clone_url, defaultBranch: row.default_branch, createdBy: row.created_by, createdAt: this.iso(row.created_at) };
  }

  private toCodeTask(row: CodeTaskRow): TeamCodeTask {
    return {
      id: row.id, teamId: row.team_id, projectId: row.project_id, createdBy: row.created_by,
      branch: row.branch, instructions: row.instructions, status: row.status,
      ...(row.executor_job_id ? { executorJobId: row.executor_job_id } : {}),
      executorAttempts: Number(row.executor_attempts ?? 0),
      ...(row.executor_started_at ? { executorStartedAt: this.iso(row.executor_started_at) } : {}),
      ...(row.executor_finished_at ? { executorFinishedAt: this.iso(row.executor_finished_at) } : {}),
      ...(row.executor_result ? { executorResult: row.executor_result } : {}),
      ...(row.executor_error ? { executorError: row.executor_error } : {}),
      ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
      ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
      ...(row.decided_at ? { decidedAt: this.iso(row.decided_at) } : {}),
      createdAt: this.iso(row.created_at), updatedAt: this.iso(row.updated_at),
    };
  }

  async requireMembership(principal: Principal, teamId: string): Promise<TeamRole> {
    const result = await this.store.pool.query<{ role: TeamRole }>("SELECT role FROM team_memberships WHERE team_id=$1 AND user_id=$2", [teamId, principal.userId]);
    const role = result.rows[0]?.role;
    if (!role) throw new HttpError(404, "Team not found");
    return role;
  }

  async requireRole(principal: Principal, teamId: string, roles: Set<TeamRole>): Promise<TeamRole> {
    const role = await this.requireMembership(principal, teamId);
    if (!roles.has(role)) throw new HttpError(403, "Your team role does not allow this action");
    return role;
  }

  private async requireRoleIn(client: PoolClient, principal: Principal, teamId: string, roles: Set<TeamRole>): Promise<TeamRole> {
    const result = await client.query<{ role: TeamRole }>(
      "SELECT role FROM team_memberships WHERE team_id=$1 AND user_id=$2 FOR SHARE", [teamId, principal.userId],
    );
    const role = result.rows[0]?.role;
    if (!role) throw new HttpError(404, "Team not found");
    if (!roles.has(role)) throw new HttpError(403, "Your team role does not allow this action");
    return role;
  }

  private async ensureAnotherOwner(client: PoolClient, teamId: string, userId: string): Promise<void> {
    const owners = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM team_memberships WHERE team_id=$1 AND role='owner' AND user_id<>$2", [teamId, userId]);
    if (Number(owners.rows[0]?.count ?? 0) < 1) throw new HttpError(409, "A team must keep at least one owner");
  }

  private async notifyConversations(client: PoolClient, conversationIds: string[]): Promise<void> {
    for (const conversationId of new Set(conversationIds)) {
      await client.query("SELECT pg_notify('team_conversation_updates', $1)", [conversationId]);
    }
  }

  private async cancelCodeTasksForMember(client: PoolClient, teamId: string, userId: string, reason: string): Promise<void> {
    const now = new Date(this.now());
    const cancelled = await client.query<{ id: string }>(
      `UPDATE team_code_tasks SET status='cancelled', executor_error=$3, executor_lease_until=NULL,
             executor_capability_hash=NULL, executor_capability_encrypted=NULL, executor_finished_at=$4, updated_at=$4
        WHERE team_id=$1 AND created_by=$2 AND status IN ('pending_approval','approved_waiting_executor','dispatching','running')
        RETURNING id`, [teamId, userId, reason, now],
    );
    for (const task of cancelled.rows) await this.audit(client, teamId, null, "code_task.cancelled", "code_task", task.id, { reason, createdBy: userId });
  }

  private async cancelCodeTasksForModelCredential(client: PoolClient, teamId: string, reason: string): Promise<void> {
    const now = new Date(this.now());
    const cancelled = await client.query<{ id: string; created_by: string; project_id: string }>(
      `UPDATE team_code_tasks SET status='cancelled', executor_error=$2, executor_lease_until=NULL,
             executor_capability_hash=NULL, executor_capability_encrypted=NULL, executor_finished_at=$3, updated_at=$3
        WHERE team_id=$1 AND status IN ('approved_waiting_executor','dispatching','running')
        RETURNING id, created_by, project_id`, [teamId, reason, now],
    );
    for (const task of cancelled.rows) await this.audit(client, teamId, null, "code_task.cancelled", "code_task", task.id, { reason, createdBy: task.created_by, projectId: task.project_id });
  }

  private async audit(client: PoolClient, teamId: string, actorId: string | null, action: string, targetType: string, targetId: string, details: unknown): Promise<void> {
    await client.query("INSERT INTO team_audit_events(id,team_id,actor_user_id,action,target_type,target_id,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id(), teamId, actorId, action, targetType, targetId, JSON.stringify(details), new Date(this.now())]);
  }

  private toUser(row: { id: string; email: string; created_at: Date | string }): User {
    return { id: row.id, email: row.email, createdAt: this.iso(row.created_at) };
  }

  private toInvitation(row: InvitationRow): Invitation {
    return { id: row.id, teamId: row.team_id, email: row.email, role: row.role, expiresAt: this.iso(row.expires_at), createdAt: this.iso(row.created_at) };
  }

  private iso(value: Date | string): string {
    return new Date(value).toISOString();
  }
}

function safeCount(value: string): number {
  const parsed = BigInt(value);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
}

function boundedExecutorText(value: unknown, limit: number, fallback: string): string {
  if (value == null) return fallback;
  const text = typeof value === "string" ? value.trim() : JSON.stringify(value);
  if (!text) return fallback;
  if (text.length > limit) throw new HttpError(400, "Executor result is too large");
  return text;
}
