export type TeamRole = "owner" | "admin" | "developer" | "viewer";

/** 团队模型授权模式：all 不限制，catalog 使用部署目录，allowlist 使用团队白名单 */
export type TeamModelPolicyMode = "all" | "catalog" | "allowlist";

export interface TeamModelPolicy {
  mode: TeamModelPolicyMode;
  /** allowlist 模式下团队授权的模型列表 */
  allowedModels: string[];
  /** 部署侧登记的模型目录 */
  catalogModels: string[];
  /** 当前成员在该策略下可以选择的模型列表 */
  availableModels: string[];
  /** 当前成员已选择的模型；未设置表示跟随团队默认 */
  memberModel?: string;
  updatedAt?: string;
}

/**
 * 叠加限制层的一条规则。基线（TeamModelPolicy）决定「能选哪些模型」，
 * 这些规则决定「选完之后还要遵守什么」——黑名单、速率、token 配额、角色范围。
 * 多条规则之间是「与」关系，命中任一条即拒绝。
 */
export interface TeamModelPolicyRule {
  id: string;
  teamId: string;
  ruleName: string;
  enabled: boolean;
  /** 非空时模型必须在此名单内；空数组表示不限制模型 */
  allowedModels: string[];
  blockedModels: string[];
  maxRequestsPerUserPerHour: number | null;
  maxRequestsPerTeamPerHour: number | null;
  maxInputTokensPerRequest: number | null;
  maxOutputTokensPerRequest: number | null;
  maxTotalTokensPerUserPerDay: string | null;
  /** 空数组表示对所有角色生效 */
  appliesToRoles: TeamRole[];
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

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  role: TeamRole;
  createdAt: string;
}

export interface Member {
  userId: string;
  email: string;
  role: TeamRole;
  joinedAt: string;
}

export interface Invitation {
  id: string;
  teamId: string;
  email: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  createdAt: string;
  inviteUrl?: string;
}

export interface TeamBot {
  id: string;
  teamId: string;
  name: string;
  description: string;
  instructions: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamConversation {
  id: string;
  teamId: string;
  botId: string;
  botName: string;
  title: string;
  visibility: "team" | "private";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMessage {
  id: string;
  conversationId: string;
  authorUserId: string | null;
  authorEmail: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface TeamJob {
  id: string;
  conversationId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attemptCount: number;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamUsageMember {
  userId: string;
  email: string;
  successfulJobs: number;
  reportedJobs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TeamUsage {
  scope: "team" | "member";
  periodStart: string;
  successfulJobs: number;
  reportedJobs: number;
  inputTokens: number;
  outputTokens: number;
  members: TeamUsageMember[];
}

export interface TeamAuditEvent {
  id: string;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TeamProject {
  id: string;
  teamId: string;
  name: string;
  provider: "github" | "gitlab";
  repositoryUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  createdBy: string;
  createdAt: string;
}

export type TeamCodeTaskStatus = "pending_approval" | "approved_waiting_executor" | "dispatching" | "running" | "succeeded" | "failed" | "rejected" | "cancelled";

export interface TeamCodeTask {
  id: string;
  teamId: string;
  projectId: string;
  createdBy: string;
  branch: string;
  instructions: string;
  status: TeamCodeTaskStatus;
  executorJobId?: string;
  executorAttempts: number;
  executorStartedAt?: string;
  executorFinishedAt?: string;
  executorResult?: string;
  executorError?: string;
  decisionReason?: string;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodeTaskDispatch {
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

export interface Principal {
  userId: string;
  email: string;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
