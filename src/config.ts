import fs from "node:fs";
import path from "node:path";
import { normalizeLine, type ModelflareLine } from "./modelflare.js";
import { normalizeGuide, type GuideState } from "./guide.js";
import { normalizeLangPref, type LangPref } from "./i18n/index.js";

/**
 * 配置：<dataDir>/config.json。
 *
 * **白标版不读进程环境变量。** `loadConfig({ env })` 的 env 只是一个测试注入口：
 * 调用方显式传一个对象进来（集成测试就是这么用的），不传时是空对象 `{}`，
 * 生产入口（src/main.ts / electron/main.ts / cli）都不传，所以环境里放什么都不会生效。
 * 少一层"环境变量优先于文件"的覆盖，就少一条谁都能改自己机器上环境变量从而改道的路。
 */
export interface AppConfig {
  dataDir: string;
  ui: {
    host: string;
    port: number;
    token: string;
    /** 桌面版窗口缩放（1 = 100%） */
    zoom: number;
    /** 桌面版关闭窗口时：true 隐藏到托盘，false 退出 */
    closeToTray: boolean;
    /** Windows 上"建议安装 PowerShell 7"的提示点过"不再提示" */
    pwshHintDismissed: boolean;
    /** 新手引导（上手清单）的进度，见 src/guide.ts */
    guide: GuideState;
    /** 界面语言：system 跟随系统，或 zh-CN / en；托盘菜单和机器人发出的系统消息也用它（src/i18n） */
    lang: LangPref;
  };
  /**
   * zdzui 线路；密钥本身只存在内置 magpie 的隔离配置里。
   * lowBalanceUsd：余额低于它（美元）时提醒，0 = 不提醒；lowBalancePush：同时经机器人发到微信 / 飞书。
   */
  modelflare: { line: ModelflareLine; lowBalanceUsd: number; lowBalancePush: boolean };
  magpie: {
    /** managed：由本程序启动并守护内置 magpie；external：使用已有 OpenAI 兼容端点（测试/高级用法） */
    mode: "managed" | "external";
    binPath: string;
    externalBaseUrl: string;
    externalApiKey: string;
  };
  llm: { defaultModel: string; contextMessages: number; contextChars: number };
  /** 默认的图片 / 视频模型（生成前确认时默认选中）；空 = 按推荐顺序的第一个 */
  media: { imageModel: string; videoModel: string };
  feishu: { throttleMs: number };
  /** cdnBaseUrl：收发图片/文件的微信 CDN（测试时指向假服务） */
  weixin: { apiBaseUrl: string; cdnBaseUrl: string };
  /**
   * 代理宿主：dsh = DeepSeek Harness（工具/沙箱/审批）；off = 纯对话。
   * pwsh（Windows）：auto = 系统里没有能用的 PowerShell 7 时用应用内置的（自动安装）；system = 改回系统默认，不用内置的。
   * pwshRoot / pwshMirror / pwshAutoInstall：内置 PowerShell 的安装位置、下载镜像前缀、是否自动装（原来在环境变量里，改到这里）。
   * pwshIgnoreSystem：调试用，装作系统里没有 PowerShell 7（外部脚本已无法设置，只有本文件与测试能）。
   */
  /** maxBackground：所有机器人加起来最多同时跑几个后台任务 */
  agent: { mode: "dsh" | "off"; turnTimeoutMs: number; idleTimeoutMs: number; approvalTtlMs: number; pwsh: "auto" | "system"; maxBackground: number; pwshRoot?: string; pwshMirror?: string; pwshAutoInstall?: boolean; pwshIgnoreSystem?: boolean };
}

export function defaultDataDir(): string {
  return path.resolve(process.cwd(), "data");
}

export const ZOOMS = [1, 1.1, 1.25, 1.5];

function num(v: string | undefined, d: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 低余额提醒线（美元）：0–1000，缺省 1 */
export function normalizeLowBalance(v: unknown): number {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n >= 0 && n <= 1000 ? n : 1;
}

export function loadConfig(overrides: { dataDir?: string; env?: NodeJS.ProcessEnv } = {}): AppConfig {
  // 注意：默认是空对象，不是 process.env。env 只给测试注入用（见文件头）。
  const env = overrides.env ?? {};
  const dataDir = overrides.dataDir ?? defaultDataDir();
  let file: Partial<AppConfig> & Record<string, any> = {};
  const p = path.join(dataDir, "config.json");
  if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    dataDir,
    ui: {
      host: env.AMB_UI_HOST || file.ui?.host || "127.0.0.1",
      port: num(env.AMB_UI_PORT, file.ui?.port ?? 3600),
      token: env.AMB_UI_TOKEN || file.ui?.token || "",
      zoom: ZOOMS.includes(Number(file.ui?.zoom)) ? Number(file.ui?.zoom) : 1,
      closeToTray: file.ui?.closeToTray !== false,
      pwshHintDismissed: file.ui?.pwshHintDismissed === true,
      guide: normalizeGuide(file.ui?.guide),
      lang: normalizeLangPref(file.ui?.lang),
    },
    modelflare: {
      line: normalizeLine(file.modelflare?.line),
      lowBalanceUsd: normalizeLowBalance(file.modelflare?.lowBalanceUsd),
      lowBalancePush: file.modelflare?.lowBalancePush === true,
    },
    magpie: {
      mode: (env.AMB_MAGPIE_BASE_URL ? "external" : file.magpie?.mode) || "managed",
      binPath: env.AMB_MAGPIE_BIN || file.magpie?.binPath || "",
      externalBaseUrl: env.AMB_MAGPIE_BASE_URL || file.magpie?.externalBaseUrl || "",
      externalApiKey: env.AMB_MAGPIE_API_KEY || file.magpie?.externalApiKey || "",
    },
    llm: {
      defaultModel: env.AMB_DEFAULT_MODEL || file.llm?.defaultModel || "",
      contextMessages: num(env.AMB_CONTEXT_MESSAGES, file.llm?.contextMessages ?? 40),
      contextChars: num(env.AMB_CONTEXT_CHARS, file.llm?.contextChars ?? 24000),
    },
    media: {
      imageModel: typeof file.media?.imageModel === "string" ? file.media.imageModel : "",
      videoModel: typeof file.media?.videoModel === "string" ? file.media.videoModel : "",
    },
    feishu: { throttleMs: num(env.AMB_FEISHU_THROTTLE_MS, file.feishu?.throttleMs ?? 400) },
    weixin: {
      apiBaseUrl: env.AMB_WEIXIN_API_BASE || file.weixin?.apiBaseUrl || "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: env.AMB_WEIXIN_CDN_BASE || file.weixin?.cdnBaseUrl || "https://novac2c.cdn.weixin.qq.com/c2c",
    },
    agent: {
      mode: (env.AMB_AGENT || file.agent?.mode || "dsh") === "off" ? "off" : "dsh",
      turnTimeoutMs: num(env.AMB_AGENT_TURN_TIMEOUT_MS, file.agent?.turnTimeoutMs ?? 30 * 60_000),
      idleTimeoutMs: num(env.AMB_AGENT_IDLE_TIMEOUT_MS, file.agent?.idleTimeoutMs ?? 10 * 60_000),
      approvalTtlMs: num(env.AMB_APPROVAL_TTL_MS, file.agent?.approvalTtlMs ?? 10 * 60_000),
      pwsh: file.agent?.pwsh === "system" ? "system" : "auto",
      maxBackground: num(env.AMB_MAX_BACKGROUND, file.agent?.maxBackground ?? 4),
      ...(typeof file.agent?.pwshRoot === "string" && file.agent.pwshRoot ? { pwshRoot: file.agent.pwshRoot } : {}),
      ...(typeof file.agent?.pwshMirror === "string" && file.agent.pwshMirror ? { pwshMirror: file.agent.pwshMirror } : {}),
      ...(typeof file.agent?.pwshAutoInstall === "boolean" ? { pwshAutoInstall: file.agent.pwshAutoInstall } : {}),
      ...(file.agent?.pwshIgnoreSystem === true ? { pwshIgnoreSystem: true } : {}),
    },
  };
}

/**
 * 改写 <dataDir>/config.json 的部分字段（读-改-写，经临时文件改名，避免写到一半被读到）。
 * 只写调用方给出的键；环境变量覆盖的值不会被写回文件。
 */
export function saveConfigFile(dataDir: string, mutate: (file: Record<string, any>) => void): void {
  const p = path.join(dataDir, "config.json");
  let file: Record<string, any> = {};
  if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, "utf8"));
  mutate(file);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}
