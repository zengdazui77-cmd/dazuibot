/** 每个机器人的身份与行为设置（存在 bots.settings JSON 列，网页可编辑）。 */
import { DEFAULT_QUIET, minuteOf, type QuietHours } from "../core/quiet.js";
export type PermissionPreset = "readonly" | "workspace" | "full";
export type CuBackend = "cua" | "codex";
export type CuApproval = "auto" | "ask-input";
/** auto = 只在预计花费超过上限时问（视频算不出花费也问）；always = 每次生成前都问 */
export type MediaConfirm = "auto" | "always";
/** 内置头像角色（ui/components/avatar.js 的 BOT_CHARS）；blue 是默认头像 */
export const BOT_AVATARS = ["blue", "yellow", "green", "red", "purple", "orange"] as const;
export type BotAvatarKey = (typeof BOT_AVATARS)[number];

export interface BotSettings {
  /**
   * 权限预设：readonly = 只读（不能改文件、命令只读沙箱）；workspace = 可写本机器人工作区（默认），越界操作需审批；
   * full = 完全权限：命令不进沙箱、不再请求提权，以用户身份读写任何文件，只有递归删除仍要用户确认
   */
  permission: PermissionPreset;
  memory: {
    enabled: boolean;
    /** 回合结束后自动整理记忆 */
    review: boolean;
    /** 是否允许写团队记忆（所有机器人共享） */
    teamWrite: boolean;
  };
  steward: {
    enabled: boolean;
  };
  /** 电脑操作 */
  computerUse: {
    enabled: boolean;
    /** cua = 随附的 Cua Driver（默认，三个平台）；codex = macOS 上的 Codex Computer Use 桥（kimi-computer-use） */
    backend: CuBackend;
    /** auto = 所有操作自动执行；ask-input = 点击/输入等改变界面的操作先问用户，读取界面仍自动（默认） */
    approval: CuApproval;
  };
  /** 生图 / 生视频 */
  media: {
    /** 生成前什么时候问用户用哪个模型（manager.ts mediaAsk） */
    confirm: MediaConfirm;
  };
  /** 后台小任务（记忆整理、上下文管家、交接摘要）用的模型；空 = 用对话模型 */
  utilityModel: string;
  /** 头像角色；空 = 由机器人 id 决定 */
  avatar: BotAvatarKey | "";
  /**
   * 预算（需要登录 zdzui 账户）：开启后机器人用自己的 API Key，最多花 limitUsd 美元
   * （包括这把 Key 已经花掉的）；关闭时与其他机器人共用本机的 Key。
   */
  budget: { enabled: boolean; limitUsd: number };
  /** 后台任务最多同时跑几个（聊天不占名额；见 tasks/slots.ts） */
  taskSlots: number;
  /** 免打扰（主人的时区）：期间的后台结果、规则命中排到结束再发；聊天回复不受影响（core/delivery.ts） */
  quietHours: QuietHours;
  /** 微信续期提醒：24 小时窗口快关时，还有消息要发就请用户回一句 */
  nudge: boolean;
  /**
   * 暂停后台工作：不开始新的任务 run（排着的等着），规则到点不跑（记为跳过、之后不补），主动消息排着等恢复；
   * 聊天照常，正在跑的那一轮照常做完（tasks/service.ts setPaused、core/delivery.ts）
   */
  paused: boolean;
}

export const DEFAULT_SETTINGS: BotSettings = {
  permission: "workspace",
  memory: { enabled: true, review: true, teamWrite: false },
  steward: { enabled: true },
  // 电脑操作默认关闭：屏幕内容会作为模型请求的一部分经过中转站，客户必须主动开启并知情。
  // approval 默认 ask-input：即使开启，改变界面的操作也要先问（读取界面仍自动）。
  computerUse: { enabled: false, backend: "cua", approval: "ask-input" },
  media: { confirm: "auto" },
  utilityModel: "",
  avatar: "",
  budget: { enabled: false, limitUsd: 5 },
  taskSlots: 2,
  quietHours: { ...DEFAULT_QUIET },
  nudge: true,
  paused: false,
};

export function normalizeSettings(raw: unknown): BotSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as any;
  const m = r.memory && typeof r.memory === "object" ? r.memory : {};
  const st = r.steward && typeof r.steward === "object" ? r.steward : {};
  const cu = r.computerUse && typeof r.computerUse === "object" ? r.computerUse : {};
  const bg = r.budget && typeof r.budget === "object" ? r.budget : {};
  const md = r.media && typeof r.media === "object" ? r.media : {};
  const qh = r.quietHours && typeof r.quietHours === "object" ? r.quietHours : {};
  const limit = Number(bg.limitUsd);
  const slots = Number(r.taskSlots);
  const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    permission: r.permission === "readonly" || r.permission === "full" ? r.permission : "workspace",
    memory: {
      enabled: b(m.enabled, DEFAULT_SETTINGS.memory.enabled),
      review: b(m.review, DEFAULT_SETTINGS.memory.review),
      teamWrite: b(m.teamWrite, DEFAULT_SETTINGS.memory.teamWrite),
    },
    steward: { enabled: b(st.enabled, DEFAULT_SETTINGS.steward.enabled) },
    computerUse: {
      enabled: b(cu.enabled, DEFAULT_SETTINGS.computerUse.enabled),
      backend: cu.backend === "codex" ? "codex" : "cua",
      // 白标：兜底也取最保守的一档。旧值（always / readonly-free）和缺失值都落到 ask-input。
      // 默认值改成"先问我"而兜底仍写 auto，就等于"默认关闭 + 任何异常配置反而自动执行"，自相矛盾；
      // 客户主动开的自动执行（明确写着 auto）仍然保留。
      approval: cu.approval === "auto" ? "auto" : "ask-input",
    },
    // 以前每次都问；升级后默认只在花费高时问
    media: { confirm: md.confirm === "always" ? "always" : "auto" },
    utilityModel: typeof r.utilityModel === "string" ? r.utilityModel.trim().slice(0, 200) : "",
    avatar: (BOT_AVATARS as readonly string[]).includes(r.avatar) ? r.avatar : "",
    budget: {
      enabled: b(bg.enabled, DEFAULT_SETTINGS.budget.enabled),
      limitUsd: Number.isFinite(limit) && limit >= 0 && limit <= 100_000 ? Math.round(limit * 100) / 100 : DEFAULT_SETTINGS.budget.limitUsd,
    },
    taskSlots: Number.isInteger(slots) && slots >= 1 && slots <= 8 ? slots : DEFAULT_SETTINGS.taskSlots,
    quietHours: {
      enabled: b(qh.enabled, DEFAULT_QUIET.enabled),
      from: typeof qh.from === "string" && minuteOf(qh.from) !== undefined ? qh.from : DEFAULT_QUIET.from,
      to: typeof qh.to === "string" && minuteOf(qh.to) !== undefined ? qh.to : DEFAULT_QUIET.to,
    },
    nudge: b(r.nudge, DEFAULT_SETTINGS.nudge),
    paused: b(r.paused, DEFAULT_SETTINGS.paused),
  };
}

/** DSH 的沙箱模式。full 用 danger-full-access，但宿主会把它的审批策略从 never 改成 ask（递归删除还要问，见 host.ts） */
export function permissionMode(p: PermissionPreset): string {
  return p === "readonly" ? "read-only" : p === "full" ? "danger-full-access" : "workspace-write";
}
