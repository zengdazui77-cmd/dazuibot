import path from "node:path";
import type { SecretBox } from "../account/vault.js";
import { registerSecret } from "../log.js";
import { TeamSessionVault, type TeamSession } from "./vault.js";
import { TeamWorkspace, type WorkspaceSnapshot } from "./workspace.js";

export interface TeamUser { id: string; email: string }
export interface TeamInfo { id: string; name: string; role: "owner" | "admin" | "developer" | "viewer"; createdAt: string }
export interface TeamMember { userId: string; email: string; role: TeamInfo["role"]; joinedAt: string }
export interface TeamInvitation { id: string; teamId: string; email: string; role: Exclude<TeamInfo["role"], "owner">; expiresAt: string; createdAt: string; inviteUrl?: string }
export interface SharedTeamBot { id: string; teamId: string; name: string; description: string; instructions: string; createdBy: string; createdAt: string; updatedAt: string }
export interface TeamConversation { id: string; teamId: string; botId: string; botName: string; title: string; visibility: "team" | "private"; createdBy: string; createdAt: string; updatedAt: string }
export interface TeamMessage { id: string; conversationId: string; authorUserId: string | null; authorEmail: string; role: "user" | "assistant"; content: string; createdAt: string }
export interface TeamJob { id: string; conversationId: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; attemptCount: number; errorCode?: string; createdAt: string; updatedAt: string }
export interface TeamModelConfig { configured: boolean; modelBaseUrl?: string; model?: string; keyTail?: string }
/** 团队模型授权模式：all 不限制，catalog 用部署目录，allowlist 用团队白名单 */
export type TeamModelPolicyMode = "all" | "catalog" | "allowlist";
export interface TeamModelPolicy {
  mode: TeamModelPolicyMode;
  allowedModels: string[];
  catalogModels: string[];
  availableModels: string[];
  memberModel?: string;
  updatedAt?: string;
}
/**
 * 叠加限制层的一条规则。基线（TeamModelPolicy）决定「能选哪些模型」，
 * 这些规则决定「选完之后还要遵守什么」——黑名单、速率、token 配额、角色范围。
 */
export interface TeamModelPolicyRule {
  id: string;
  teamId: string;
  ruleName: string;
  enabled: boolean;
  allowedModels: string[];
  blockedModels: string[];
  maxRequestsPerUserPerHour: number | null;
  maxRequestsPerTeamPerHour: number | null;
  maxInputTokensPerRequest: number | null;
  maxOutputTokensPerRequest: number | null;
  maxTotalTokensPerUserPerDay: string | null;
  appliesToRoles: string[];
  priority: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamModelPolicyViolation {
  id: string;
  teamId: string;
  ruleId: string | null;
  ruleName: string | null;
  userId: string | null;
  userEmail: string | null;
  violationType: string;
  modelRequested: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TeamUsageMember { userId: string; email: string; successfulJobs: number; reportedJobs: number; inputTokens: number; outputTokens: number }export interface TeamUsage { scope: "team" | "member"; periodStart: string; successfulJobs: number; reportedJobs: number; inputTokens: number; outputTokens: number; members: TeamUsageMember[] }
export interface TeamAuditEvent { id: string; actorEmail: string | null; action: string; targetType: string; targetId: string; details: Record<string, unknown>; createdAt: string }
export interface TeamProject { id: string; teamId: string; name: string; provider: "github" | "gitlab"; repositoryUrl: string; cloneUrl: string; defaultBranch: string; createdBy: string; createdAt: string }
export type TeamCodeTaskStatus = "pending_approval" | "approved_waiting_executor" | "dispatching" | "running" | "succeeded" | "failed" | "rejected" | "cancelled";
export interface TeamCodeTask { id: string; teamId: string; projectId: string; createdBy: string; branch: string; instructions: string; status: TeamCodeTaskStatus; executorJobId?: string; executorAttempts: number; executorStartedAt?: string; executorFinishedAt?: string; executorResult?: string; executorError?: string; decisionReason?: string; decidedBy?: string; decidedAt?: string; createdAt: string; updatedAt: string }
export interface TeamReview { url: string; number?: number; title: string; state?: string }
export interface TeamProjectDiff { head: string; base: string; diff: string; truncated: boolean }
export interface GitCredentialStatus { github: { configured: boolean; keyTail?: string }; gitlab: { configured: boolean; keyTail?: string } }

export class TeamApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Team API URL must be a valid HTTPS URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Team API URL must use HTTPS (HTTP is allowed only for localhost development)");
  }
  return url.origin;
}

export interface TeamClientOptions {
  apiBaseUrl: string;
  dataDir: string;
  secretBox: () => SecretBox | undefined;
  fetch?: typeof fetch;
  workspace?: TeamWorkspace;
}

/** Backend-only client: raw team session tokens never cross the local HTTP boundary into renderer code. */
export class TeamClient {
  private baseUrl: string;
  private configError: string | undefined;
  private readonly vault: TeamSessionVault;
  private readonly workspace: TeamWorkspace;

  constructor(private readonly options: TeamClientOptions) {
    this.vault = new TeamSessionVault(path.join(options.dataDir, "team-session.json"), options.secretBox);
    this.workspace = options.workspace ?? new TeamWorkspace(options.dataDir);
    this.baseUrl = "";
    this.setApiBaseUrl(options.apiBaseUrl);
  }

  get apiBaseUrl(): string { return this.baseUrl; }
  get configurationError(): string | undefined { return this.configError; }

  async configureApiBaseUrl(value: string): Promise<string> {
    let normalized: string;
    try { normalized = normalizeBaseUrl(value); }
    catch (error) { throw new TeamApiError(400, (error as Error).message); }
    if (normalized !== this.baseUrl) await this.revokeCurrentSession();
    this.setApiBaseUrl(normalized);
    return normalized;
  }

  /** Revoking on the server is best effort: an unreachable server must not block signing out or switching servers. */
  private async revokeCurrentSession(): Promise<void> {
    if (this.currentSession()) await this.request("/v1/auth/sessions/current", { method: "DELETE" }).catch(() => undefined);
    this.vault.clear();
  }

  private setApiBaseUrl(value: string): void {
    try { this.baseUrl = normalizeBaseUrl(value); this.configError = undefined; }
    catch (error) { this.baseUrl = ""; this.configError = (error as Error).message; }
  }

  async status(): Promise<{ configured: boolean; signedIn: boolean; user?: TeamUser; teams?: TeamInfo[]; error?: string }> {
    if (!this.baseUrl) return { configured: false, signedIn: false, ...(this.configError ? { error: this.configError } : {}) };
    const session = this.currentSession();
    if (!session) return { configured: true, signedIn: false };
    try {
      const me = await this.request<{ user: TeamUser; teams: TeamInfo[] }>("/v1/me");
      return { configured: true, signedIn: true, user: me.user, teams: me.teams };
    } catch (error) {
      if (error instanceof TeamApiError && error.status === 401) {
        this.vault.clear();
        return { configured: true, signedIn: false };
      }
      throw error;
    }
  }

  requestCode(email: unknown) { return this.request<{ expiresInSeconds: number; developmentCode?: string }>("/v1/auth/codes", { method: "POST", body: { email } }, false); }

  async signIn(email: unknown, code: unknown): Promise<void> {
    if (!this.baseUrl) throw new TeamApiError(409, this.configError ?? "Team service is not configured");
    const response = await this.request<{ token: string; expiresAt: string }>("/v1/auth/sessions", { method: "POST", body: { email, code } }, false);
    if (typeof response.token !== "string" || !response.token || typeof response.expiresAt !== "string") throw new TeamApiError(502, "Team service returned an invalid session");
    this.vault.save({ apiBaseUrl: this.baseUrl, token: response.token, expiresAt: response.expiresAt });
    registerSecret(response.token);
  }

  signOut(): Promise<void> {
    return this.revokeCurrentSession();
  }

  acceptInvitation(token: unknown) { return this.request<{ team: TeamInfo }>("/v1/invitations/accept", { method: "POST", body: { token } }); }
  listTeams() { return this.request<{ teams: TeamInfo[] }>("/v1/teams"); }
  createTeam(name: unknown) { return this.request<{ team: TeamInfo }>("/v1/teams", { method: "POST", body: { name } }); }
  deleteTeam(teamId: string, confirmName: string) {
    return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}`, { method: "DELETE", body: { confirmName } });
  }
  listMembers(teamId: string) { return this.request<{ members: TeamMember[] }>(`/v1/teams/${encodeURIComponent(teamId)}/members`); }
  listBots(teamId: string) { return this.request<{ bots: SharedTeamBot[] }>(`/v1/teams/${encodeURIComponent(teamId)}/bots`); }
  createBot(teamId: string, input: { name: unknown; description?: unknown; instructions?: unknown }) {
    return this.request<{ bot: SharedTeamBot }>(`/v1/teams/${encodeURIComponent(teamId)}/bots`, { method: "POST", body: input });
  }
  listConversations(teamId: string) { return this.request<{ conversations: TeamConversation[] }>(`/v1/teams/${encodeURIComponent(teamId)}/conversations`); }
  createConversation(teamId: string, input: { botId: string; title: unknown; visibility: "team" | "private" }) {
    return this.request<{ conversation: TeamConversation }>(`/v1/teams/${encodeURIComponent(teamId)}/conversations`, { method: "POST", body: input });
  }
  listMessages(teamId: string, conversationId: string) {
    return this.request<{ messages: TeamMessage[]; jobs: TeamJob[] }>(`/v1/teams/${encodeURIComponent(teamId)}/conversations/${encodeURIComponent(conversationId)}/messages`);
  }
  async openConversationEvents(teamId: string, conversationId: string, signal: AbortSignal): Promise<Response> {
    if (!this.baseUrl) throw new TeamApiError(409, this.configError ?? "Team service is not configured");
    const token = this.currentSession()?.token;
    if (!token) throw new TeamApiError(401, "Sign in with your team account first");
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/teams/${encodeURIComponent(teamId)}/conversations/${encodeURIComponent(conversationId)}/events`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
        redirect: "error", signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new TeamApiError(502, `Could not reach the team service: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: unknown };
      throw new TeamApiError(response.status, typeof data.error === "string" ? data.error : `Team service returned HTTP ${response.status}`);
    }
    return response;
  }
  postMessage(teamId: string, conversationId: string, content: unknown) {
    return this.request<{ message: TeamMessage; job: TeamJob }>(`/v1/teams/${encodeURIComponent(teamId)}/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: { content } });
  }
  updateMemberRole(teamId: string, userId: string, role: unknown) {
    return this.request<{ member: TeamMember }>(`/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/role`, { method: "PATCH", body: { role } });
  }
  removeMember(teamId: string, userId: string) {
    return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }
  leaveTeam(teamId: string) {
    return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/members/me`, { method: "DELETE" });
  }
  listInvitations(teamId: string) { return this.request<{ invitations: TeamInvitation[] }>(`/v1/teams/${encodeURIComponent(teamId)}/invitations`); }
  getModelConfig(teamId: string) { return this.request<{ modelConfig: TeamModelConfig }>(`/v1/teams/${encodeURIComponent(teamId)}/model-config`); }
  saveModelConfig(teamId: string, input: { model: unknown; apiKey: unknown }) {
    return this.request<{ modelConfig: TeamModelConfig }>(`/v1/teams/${encodeURIComponent(teamId)}/model-config`, { method: "PUT", body: input });
  }
  deleteModelConfig(teamId: string) { return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/model-config`, { method: "DELETE" }); }
  getModelPolicy(teamId: string) { return this.request<{ modelPolicy: TeamModelPolicy }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy`); }
  saveModelPolicy(teamId: string, input: { mode: unknown; allowedModels?: unknown }) {
    return this.request<{ modelPolicy: TeamModelPolicy }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy`, { method: "PUT", body: input });
  }
  saveMemberModel(teamId: string, model: unknown) {
    return this.request<{ modelPolicy: TeamModelPolicy }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy/model`, { method: "PUT", body: { model } });
  }
  listPolicyRules(teamId: string) { return this.request<{ rules: TeamModelPolicyRule[] }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules`); }
  getPolicyRule(teamId: string, ruleId: string) { return this.request<{ rule: TeamModelPolicyRule }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(ruleId)}`); }
  setPolicyRulesEnabled(teamId: string, ruleIds: string[], enabled: boolean) {
    return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules/enabled`, { method: "PUT", body: { ruleIds, enabled } });
  }
  createPolicyRule(teamId: string, input: Record<string, unknown>) {
    return this.request<{ rule: TeamModelPolicyRule }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules`, { method: "POST", body: input });
  }
  updatePolicyRule(teamId: string, ruleId: string, input: Record<string, unknown>) {
    return this.request<{ rule: TeamModelPolicyRule }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(ruleId)}`, { method: "PUT", body: input });
  }
  deletePolicyRule(teamId: string, ruleId: string) {
    return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
  }
  setPolicyRuleEnabled(teamId: string, ruleId: string, enabled: boolean) {
    return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(ruleId)}/enabled`, { method: "PUT", body: { enabled } });
  }
  listPolicyViolations(teamId: string) { return this.request<{ violations: TeamModelPolicyViolation[] }>(`/v1/teams/${encodeURIComponent(teamId)}/model-policy-violations`); }
  getUsage(teamId: string) { return this.request<{ usage: TeamUsage }>(`/v1/teams/${encodeURIComponent(teamId)}/usage`); }
  listAuditEvents(teamId: string) { return this.request<{ events: TeamAuditEvent[] }>(`/v1/teams/${encodeURIComponent(teamId)}/audit`); }
  listProjects(teamId: string) { return this.request<{ projects: TeamProject[] }>(`/v1/teams/${encodeURIComponent(teamId)}/projects`); }
  createProject(teamId: string, input: { name: unknown; repositoryUrl: unknown; defaultBranch: unknown }) {
    return this.request<{ project: TeamProject }>(`/v1/teams/${encodeURIComponent(teamId)}/projects`, { method: "POST", body: input });
  }
  getProject(teamId: string, projectId: string) { return this.request<{ project: TeamProject }>(`/v1/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}`); }
  deleteProject(teamId: string, projectId: string) { return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }); }
  getGitCredentialStatus(teamId: string) { return this.request<{ credentials: GitCredentialStatus }>(`/v1/teams/${encodeURIComponent(teamId)}/git-credentials`); }
  saveGitCredential(teamId: string, provider: "github" | "gitlab", token: unknown) { return this.request<{ credentials: GitCredentialStatus }>(`/v1/teams/${encodeURIComponent(teamId)}/git-credentials/${provider}`, { method: "PUT", body: { token } }); }
  deleteGitCredential(teamId: string, provider: "github" | "gitlab") { return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/git-credentials/${provider}`, { method: "DELETE" }); }
  createProjectReview(teamId: string, projectId: string, input: { head: unknown; title: unknown; body: unknown }) {
    return this.request<{ review: TeamReview }>(`/v1/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/reviews`, { method: "POST", body: input });
  }
  getProjectDiff(teamId: string, projectId: string, head: string) {
    return this.request<{ comparison: TeamProjectDiff }>(`/v1/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/diff?head=${encodeURIComponent(head)}`);
  }
  listCodeTasks(teamId: string, projectId: string) { return this.request<{ tasks: TeamCodeTask[] }>(`/v1/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/code-tasks`); }
  createCodeTask(teamId: string, projectId: string, input: { branch: unknown; instructions: unknown }) {
    return this.request<{ task: TeamCodeTask }>(`/v1/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/code-tasks`, { method: "POST", body: input });
  }
  decideCodeTask(teamId: string, projectId: string, taskId: string, decision: "approve" | "reject", reason?: string) {
    return this.request<{ task: TeamCodeTask }>(`/v1/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/code-tasks/${encodeURIComponent(taskId)}/${decision}`, { method: "POST", body: { reason } });
  }
  cancelCodeTask(teamId: string, projectId: string, taskId: string) {
    return this.request<{ task: TeamCodeTask }>(`/v1/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/code-tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
  }
  async checkoutProject(teamId: string, projectId: string) {
    const [projectResponse, me] = await Promise.all([
      this.getProject(teamId, projectId),
      this.request<{ user: TeamUser; teams: TeamInfo[] }>("/v1/me"),
    ]);
    if (!me.user?.id) throw new TeamApiError(401, "Sign in with your team account first");
    return this.workspace.checkout(teamId, projectResponse.project, me.user.id, me.user.email);
  }
  async inspectProject(teamId: string, projectId: string): Promise<WorkspaceSnapshot> {
    const [projectResponse, me] = await Promise.all([
      this.getProject(teamId, projectId),
      this.request<{ user: TeamUser; teams: TeamInfo[] }>("/v1/me"),
    ]);
    if (!me.user?.id) throw new TeamApiError(401, "Sign in with your team account first");
    return this.workspace.inspect(teamId, projectResponse.project, me.user.id);
  }
  createInvitation(teamId: string, email: unknown, role: unknown) {
    return this.request<{ invitation: TeamInvitation; emailSent: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/invitations`, { method: "POST", body: { email, role } });
  }
  revokeInvitation(teamId: string, invitationId: string) {
    return this.request<{ ok: boolean }>(`/v1/teams/${encodeURIComponent(teamId)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
  }

  private currentSession(): TeamSession | undefined {
    let session: TeamSession | undefined;
    // An unreadable session file (keychain changed, corrupt file) means signed out, not a permanently broken team page.
    try { session = this.vault.load(); }
    catch { this.vault.clear(); return undefined; }
    if (!session) return undefined;
    const expiresAt = Date.parse(session.expiresAt);
    if (session.apiBaseUrl !== this.baseUrl || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      this.vault.clear();
      return undefined;
    }
    return session;
  }

  private async request<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}, authenticated = true): Promise<T> {
    if (!this.baseUrl) throw new TeamApiError(409, this.configError ?? "Team service is not configured");
    const token = authenticated ? this.currentSession()?.token : undefined;
    if (authenticated && !token) throw new TeamApiError(401, "Sign in with your team account first");
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const fetcher = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new TeamApiError(502, `Could not reach the team service: ${(error as Error).message}`);
    }
    const data = await response.json().catch(() => ({})) as { error?: unknown } & T;
    if (!response.ok) throw new TeamApiError(response.status, typeof data.error === "string" ? data.error : `Team service returned HTTP ${response.status}`);
    return data;
  }
}
