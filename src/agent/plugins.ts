/**
 * 插件社区：用户自己挑选安装的 MCP 服务器（设置 › 插件）。全局一份，所有机器人共用。
 *
 * - 精选目录（CATALOG）：成熟、由厂商或协议官方维护的 MCP 服务器；也可以添加自定义的。
 * - 两种运行方式：远程（Streamable HTTP，数据发给对方的服务器）和本机（stdio，用 npx 在这台电脑上运行，需要 Node.js）。
 * - 接进代理：每个启用的插件是 DSH 的一个 mcp-client 条目（host.ts 写进补丁），工具名是 mcp__plg-<id>__<tool>。
 * - 密钥只经环境变量交给代理进程（AMB_PLUGIN_SECRET_n），补丁文件里只有对它的引用：补丁在代理能读的目录里，
 *   而命令工具继承的环境会去掉名字里带 SECRET 的变量，所以模型读不到。接口也从不把密钥发回界面。
 * - 审批：ask（默认）时插件的每次工具调用都先问用户（amb-plugin-gate 插件）；auto 直接执行。只读机器人一律先问。
 *   本机插件不在命令沙箱里，规则会话不给插件工具（tasks/rules.ts 的 RULE_DENY_PREFIX）。
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lang, t } from "../i18n/index.js";

export type PluginTransport = "http" | "stdio";
export type PluginApproval = "ask" | "auto";
type Text = { zh: string; en: string };

export interface PluginSecretField {
  key: string;
  label: Text;
  /** 去哪里申请 */
  url?: string;
  optional?: boolean;
}

/** 一个插件怎么连：模板里的 {key} 换成对应的密钥 */
export interface PluginSpec {
  transport: PluginTransport;
  /** http：地址（{key} 会做 URL 编码） */
  url?: string;
  headers?: Record<string, string>;
  /** stdio：命令、参数（参数里不放密钥：进程列表看得见）、环境变量 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CatalogPlugin extends PluginSpec {
  id: string;
  name: string;
  category: "search" | "docs" | "dev" | "maps" | "browser" | "thinking";
  maintainer: string;
  homepage: string;
  license?: string;
  desc: Text;
  secrets?: PluginSecretField[];
  /** 只查资料的（搜索、文档）默认直接执行；能改东西或操作浏览器的默认先问 */
  defaultApproval: PluginApproval;
}

const NPX = "npx";

/**
 * 精选目录。收录标准：厂商或协议官方维护、公开文档写明接入方式。地址和包名在 2026-11 核对过
 * （远程端点能完成 MCP 握手或按预期要求凭据；npm 包存在）；每个插件装好后界面会实际连一次并显示结果。
 */
export const CATALOG: CatalogPlugin[] = [
  {
    id: "context7", name: "Context7", category: "docs", maintainer: "Upstash", homepage: "https://context7.com", license: "MIT", defaultApproval: "auto",
    desc: { zh: "查各种开源库的最新文档和代码示例，写代码时少用过时的写法。不填 Key 也能用，填了额度更高。", en: "Up-to-date docs and code examples for open-source libraries. Works without a key; a key raises the limits." },
    transport: "http", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: "{key}" },
    secrets: [{ key: "key", label: { zh: "Context7 API Key（可选）", en: "Context7 API key (optional)" }, url: "https://context7.com/dashboard", optional: true }],
  },
  {
    id: "exa", name: "Exa Search", category: "search", maintainer: "Exa", homepage: "https://exa.ai", license: "MIT", defaultApproval: "auto",
    desc: { zh: "面向 AI 的联网搜索和网页抓取。不需要 Key。", en: "Web search and page fetching built for AI. No key needed." },
    transport: "http", url: "https://mcp.exa.ai/mcp",
  },
  {
    id: "tavily", name: "Tavily", category: "search", maintainer: "Tavily", homepage: "https://tavily.com", license: "MIT", defaultApproval: "auto",
    desc: { zh: "联网搜索、网页内容提取与站点爬取。需要 Tavily API Key。", en: "Web search, page extraction and site crawling. Needs a Tavily API key." },
    transport: "http", url: "https://mcp.tavily.com/mcp/?tavilyApiKey={key}",
    secrets: [{ key: "key", label: { zh: "Tavily API Key", en: "Tavily API key" }, url: "https://app.tavily.com" }],
  },
  {
    id: "amap", name: "高德地图 AMap", category: "maps", maintainer: "高德开放平台", homepage: "https://lbs.amap.com", defaultApproval: "auto",
    desc: { zh: "地点搜索、路线规划、天气和地理编码（中国大陆数据最全）。需要高德开放平台的 Key。", en: "Place search, routing, weather and geocoding (best coverage in mainland China). Needs an AMap key." },
    transport: "http", url: "https://mcp.amap.com/mcp?key={key}",
    secrets: [{ key: "key", label: { zh: "高德 Web 服务 Key", en: "AMap Web Service key" }, url: "https://console.amap.com/dev/key/app" }],
  },
  {
    id: "github", name: "GitHub", category: "dev", maintainer: "GitHub", homepage: "https://github.com/github/github-mcp-server", license: "MIT", defaultApproval: "ask",
    desc: { zh: "读写仓库、Issue、Pull Request 和 Actions。需要 GitHub 访问令牌，建议用只授权所需仓库的细粒度令牌。", en: "Read and write repositories, issues, pull requests and Actions. Needs a GitHub token; prefer a fine-grained token limited to the repositories you need." },
    transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer {token}" },
    secrets: [{ key: "token", label: { zh: "GitHub 访问令牌", en: "GitHub access token" }, url: "https://github.com/settings/personal-access-tokens" }],
  },
  {
    id: "firecrawl", name: "Firecrawl", category: "search", maintainer: "Firecrawl", homepage: "https://firecrawl.dev", license: "MIT", defaultApproval: "ask",
    desc: { zh: "把网页和整站抓成干净的 Markdown，支持搜索和结构化提取。需要 Firecrawl API Key。", en: "Turns pages and whole sites into clean Markdown, with search and structured extraction. Needs a Firecrawl API key." },
    transport: "stdio", command: NPX, args: ["-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY: "{key}" },
    secrets: [{ key: "key", label: { zh: "Firecrawl API Key", en: "Firecrawl API key" }, url: "https://www.firecrawl.dev/app/api-keys" }],
  },
  {
    id: "playwright", name: "Playwright", category: "browser", maintainer: "Microsoft", homepage: "https://github.com/microsoft/playwright-mcp", license: "Apache-2.0", defaultApproval: "ask",
    desc: { zh: "让机器人打开并操作一个浏览器：点击、填表、截图、读页面。需要本机装有 Chrome。", en: "Lets the bot drive a browser: click, fill forms, take screenshots, read pages. Needs Chrome on this computer." },
    transport: "stdio", command: NPX, args: ["-y", "@playwright/mcp@latest"],
  },
  {
    id: "chrome-devtools", name: "Chrome DevTools", category: "browser", maintainer: "Google", homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp", license: "Apache-2.0", defaultApproval: "ask",
    desc: { zh: "用 Chrome 开发者工具调试网页：看控制台、网络请求和性能。需要本机装有 Chrome。", en: "Debug web pages with Chrome DevTools: console, network requests and performance. Needs Chrome on this computer." },
    transport: "stdio", command: NPX, args: ["-y", "chrome-devtools-mcp@latest"],
  },
  {
    id: "sequential-thinking", name: "Sequential Thinking", category: "thinking", maintainer: "Model Context Protocol", homepage: "https://github.com/modelcontextprotocol/servers", defaultApproval: "auto",
    desc: { zh: "给模型一个分步推理的草稿本，适合拆解复杂问题。不联网，不需要 Key。", en: "A scratchpad for step-by-step reasoning on complex problems. Offline; no key needed." },
    transport: "stdio", command: NPX, args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
];

export class PluginError extends Error {}

/** 存下来的一条（KV）。custom 有值 = 自定义插件，否则按 catalogId 找目录项 */
interface PluginRecord {
  id: string;
  catalogId?: string;
  name: string;
  custom?: PluginSpec;
  enabled: boolean;
  approval: PluginApproval;
  secrets: Record<string, string>;
  addedAt: number;
  lastTest?: PluginTestResult;
}

export interface PluginTestResult {
  ok: boolean;
  /** 连上后列出的工具名（最多 60 个） */
  tools: string[];
  error?: string;
  at: number;
  ms: number;
}

/** 交给代理宿主的：一个启用且配齐了的插件 */
export interface ResolvedPlugin extends PluginSpec {
  id: string;
  /** MCP 服务器名：plg-<id>，工具名的前缀就是 mcp__plg-<id>__ */
  server: string;
  secrets: Record<string, string>;
  approval: PluginApproval;
}

/** 给界面的：没有密钥，只说哪些填了 */
export interface PluginView {
  id: string;
  catalogId?: string;
  name: string;
  custom: boolean;
  transport: PluginTransport;
  /** 远程是主机名，本机是命令行（不含环境变量） */
  target: string;
  enabled: boolean;
  approval: PluginApproval;
  secretsSet: string[];
  /** 必填的密钥没填全：不会接进代理 */
  needsSetup: boolean;
  lastTest?: PluginTestResult;
}

export const PLUGIN_SERVER_PREFIX = "plg-";
/** 插件工具名的前缀（规则会话按它拒绝） */
export const PLUGIN_TOOL_PREFIX = `mcp__${PLUGIN_SERVER_PREFIX}`;
const KV_KEY = "plugins.v1";
const MAX_PLUGINS = 20;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type Part = { text: string } | { key: string };
function parts(template: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (m.index > last) out.push({ text: template.slice(last, m.index) });
    out.push({ key: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last) });
  return out;
}
const keysOf = (template: string) => parts(template).flatMap((p) => ("key" in p ? [p.key] : []));
/** 模板引用的密钥都有值（引用了没填的可选密钥的那一项整个不发） */
const usable = (template: string, secrets: Record<string, string>) => keysOf(template).every((k) => !!secrets[k]);
/** 宿主这边直接算出最终的值（连接测试用） */
function render(template: string, secrets: Record<string, string>, encode = false): string {
  const ps = parts(template);
  // 整个模板就是一个密钥（自定义插件的完整地址）时原样使用：只有嵌在地址里的 Key 才做 URL 编码
  const enc = encode && ps.length > 1;
  return ps.map((p) => ("text" in p ? p.text : enc ? encodeURIComponent(secrets[p.key] ?? "") : (secrets[p.key] ?? ""))).join("");
}

/**
 * 写进 DSH 补丁的插件条目（缩进到 insert 列表项）和要放进代理进程环境的变量。
 * 密钥只出现在 env 里；补丁里是 `!!js` 表达式，DSH 加载这一条时从它自己的环境取值。
 * forceAsk：只读机器人，所有插件工具都先问。gate：amb-plugin-gate.mjs 的路径。
 */
export function pluginPatch(plugins: ResolvedPlugin[], o: { gate: string; forceAsk?: boolean }): { lines: string[]; env: Record<string, string> } {
  const lines: string[] = [];
  const env: Record<string, string> = {};
  const ask: string[] = [];
  const y = (s: string) => JSON.stringify(s);
  let n = 0;
  for (const p of plugins) {
    const names = new Map<string, string>();
    const ref = (key: string) => {
      let name = names.get(key);
      if (!name) {
        name = `AMB_PLUGIN_SECRET_${n++}`;
        names.set(key, name);
        env[name] = p.secrets[key] ?? "";
      }
      return name;
    };
    const value = (template: string, encode = false) => {
      const ps = parts(template);
      if (ps.every((x) => "text" in x)) return y(template);
      // 和 render() 一致：整个模板就是一个密钥（完整地址）时不做 URL 编码
      const enc = encode && ps.length > 1;
      return `!!js ${y(ps.map((x) => ("text" in x ? y(x.text) : enc ? `encodeURIComponent(process.env.${ref(x.key)})` : `process.env.${ref(x.key)}`)).join(" + "))}`;
    };
    const entries = (map: Record<string, string> | undefined) => Object.entries(map ?? {}).filter(([, v]) => usable(v, p.secrets)).map(([k, v]) => `          ${y(k)}: ${value(v)}`);
    lines.push(`    - id: amb-plugin-${p.id}`, "      name: '@deepseek-ai/dsh-mcp-client'", "      config:");
    if (p.transport === "http") {
      lines.push("        transport: streamable-http", `        serverName: ${p.server}`, `        url: ${value(p.url ?? "", true)}`);
      const headers = entries(p.headers);
      if (headers.length) lines.push("        headers:", ...headers);
    } else {
      lines.push("        transport: stdio", `        serverName: ${p.server}`, `        command: ${y(p.command ?? "")}`, `        args: [${(p.args ?? []).map(y).join(", ")}]`);
      const vars = entries(p.env);
      if (vars.length) lines.push("        env:", ...vars);
    }
    // 连不上不拦着代理启动；重连 3 次就停（默认 10 次、约 2.5 分钟），下次代理重启时再连
    lines.push("        toolCallTimeoutMs: 120000", "        failOnStartupError: false", "        reconnect:", "          maxAttempts: 3", "          initialDelayMs: 2000");
    if (o.forceAsk || p.approval === "ask") ask.push(p.server);
  }
  if (plugins.length) env.AMB_PLUGIN_ASK = JSON.stringify(ask);
  if (ask.length) lines.push("    - id: amb-plugin-gate", `      name: ${y(o.gate)}`);
  return { lines, env };
}

/** 插件集合的签名（含密钥的摘要）：变了，空闲的代理进程重启后才生效 */
export function pluginSignature(plugins: ResolvedPlugin[]): string {
  return plugins.length ? createHash("sha256").update(JSON.stringify(plugins)).digest("hex").slice(0, 16) : "";
}

export interface PluginServiceOptions {
  kv: { getKV(key: string): string | undefined; setKV(key: string, value: string): void };
  /** DSH 运行时目录：连接测试用它带的 MCP 客户端；没有（代理模式不可用）时不能测试 */
  runtimeDir?: () => string | undefined;
  /** 桌面版：远程插件的连接测试走系统代理与系统证书 */
  fetch?: () => typeof fetch | undefined;
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 自定义插件：只接受明确的字段；环境变量的值当密钥存 */
function customSpec(raw: any): { name: string; spec: PluginSpec; secrets: Record<string, string> } {
  const name = text(raw?.name, 40);
  if (!name) throw new PluginError(t("agent.pluginNameMissing"));
  if (raw?.transport === "stdio") {
    const command = text(raw.command, 300);
    if (!command || /[\r\n\0]/.test(command)) throw new PluginError(t("agent.pluginBadCommand"));
    const args = Array.isArray(raw.args) ? raw.args.map((a: unknown) => String(a)) : [];
    if (args.length > 40 || args.some((a: string) => a.length > 500 || /[\r\n\0]/.test(a))) throw new PluginError(t("agent.pluginBadCommand"));
    const env: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env && typeof raw.env === "object" ? raw.env : {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || typeof v !== "string" || v.length > 4096 || /[\r\n\0]/.test(v)) throw new PluginError(t("agent.pluginBadEnv"));
      env[k] = `{${k}}`;
      secrets[k] = v;
    }
    if (Object.keys(env).length > 20) throw new PluginError(t("agent.pluginBadEnv"));
    return { name, spec: { transport: "stdio", command, args, env }, secrets };
  }
  let url: URL;
  try {
    url = new URL(text(raw?.url, 2000));
  } catch {
    throw new PluginError(t("agent.pluginBadUrl"));
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password) throw new PluginError(t("agent.pluginBadUrl"));
  const authorization = typeof raw.authorization === "string" ? raw.authorization.trim() : "";
  if (authorization.length > 4096 || /[\r\n\0]/.test(authorization)) throw new PluginError(t("agent.pluginBadEnv"));
  // 地址里的查询参数常常就是 Key：整个地址当密钥存，不写进补丁
  return { name, spec: { transport: "http", url: "{url}", headers: { Authorization: "{authorization}" } }, secrets: { url: url.toString(), ...(authorization ? { authorization } : {}) } };
}

export class PluginService {
  private records: PluginRecord[];
  private npx: { at: number; ok: boolean } | undefined;

  constructor(private readonly o: PluginServiceOptions) {
    let raw: unknown = [];
    try {
      raw = JSON.parse(o.kv.getKV(KV_KEY) ?? "[]");
    } catch {
      /* 坏了：从空开始 */
    }
    this.records = (Array.isArray(raw) ? raw : []).filter((r): r is PluginRecord => !!r && typeof r === "object" && typeof (r as PluginRecord).id === "string");
  }

  private save(): void {
    this.o.kv.setKV(KV_KEY, JSON.stringify(this.records));
  }

  catalog(): CatalogPlugin[] {
    return CATALOG;
  }

  private specOf(r: PluginRecord): { spec: PluginSpec; fields: PluginSecretField[] } | undefined {
    if (r.custom) return { spec: r.custom, fields: [] };
    const c = CATALOG.find((x) => x.id === r.catalogId);
    return c ? { spec: c, fields: c.secrets ?? [] } : undefined;
  }

  private needsSetup(r: PluginRecord): boolean {
    const s = this.specOf(r);
    return !s || s.fields.some((f) => !f.optional && !r.secrets[f.key]);
  }

  private view(r: PluginRecord): PluginView {
    const spec = this.specOf(r)?.spec;
    let target = "";
    if (spec?.transport === "http") {
      try {
        target = new URL(render(spec.url ?? "", r.secrets)).host;
      } catch {
        /* 地址还没配好 */
      }
    } else if (spec) target = [spec.command, ...(spec.args ?? [])].join(" ");
    return {
      id: r.id, ...(r.catalogId ? { catalogId: r.catalogId } : {}), name: r.name, custom: !!r.custom, transport: spec?.transport ?? "http", target,
      enabled: r.enabled, approval: r.approval, secretsSet: Object.keys(r.secrets).filter((k) => !!r.secrets[k]), needsSetup: this.needsSetup(r),
      ...(r.lastTest ? { lastTest: r.lastTest } : {}),
    };
  }

  list(): PluginView[] {
    return this.records.map((r) => this.view(r));
  }

  private resolve(r: PluginRecord): ResolvedPlugin | undefined {
    const spec = this.specOf(r)?.spec;
    if (!spec || this.needsSetup(r)) return undefined;
    return {
      id: r.id, server: `${PLUGIN_SERVER_PREFIX}${r.id}`, transport: spec.transport, approval: r.approval, secrets: { ...r.secrets },
      ...(spec.url !== undefined ? { url: spec.url } : {}), ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.command !== undefined ? { command: spec.command } : {}), ...(spec.args ? { args: spec.args } : {}), ...(spec.env ? { env: spec.env } : {}),
    };
  }

  /** 启用且配齐了的插件：代理宿主把它们写进补丁 */
  runtime(): ResolvedPlugin[] {
    return this.records.filter((r) => r.enabled).flatMap((r) => this.resolve(r) ?? []);
  }

  private get(id: string): PluginRecord {
    const r = this.records.find((x) => x.id === id);
    if (!r) throw new PluginError(t("agent.pluginUnknown"));
    return r;
  }

  private secretsFrom(fields: PluginSecretField[], raw: unknown, current: Record<string, string> = {}): Record<string, string> {
    const given = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const out = { ...current };
    for (const f of fields) {
      const v = given[f.key];
      if (v === undefined) continue;
      if (typeof v !== "string" || v.length > 4096 || /[\r\n\0]/.test(v)) throw new PluginError(t("agent.pluginBadEnv"));
      if (v.trim()) out[f.key] = v.trim();
      else delete out[f.key];
    }
    const missing = fields.find((f) => !f.optional && !out[f.key]);
    if (missing) throw new PluginError(t("agent.pluginSecretMissing", { name: lang() === "zh-CN" ? missing.label.zh : missing.label.en }));
    return out;
  }

  /** 安装：{ id, secrets } 装目录里的一个；{ custom: {...} } 加一个自定义的 */
  install(raw: any): PluginView {
    if (this.records.length >= MAX_PLUGINS) throw new PluginError(t("agent.pluginTooMany", { max: MAX_PLUGINS }));
    let record: PluginRecord;
    if (raw?.custom) {
      const c = customSpec(raw.custom);
      record = { id: `c-${randomBytes(4).toString("hex")}`, name: c.name, custom: c.spec, enabled: true, approval: "ask", secrets: c.secrets, addedAt: Date.now() };
    } else {
      const c = CATALOG.find((x) => x.id === raw?.id);
      if (!c) throw new PluginError(t("agent.pluginUnknown"));
      if (this.records.some((r) => r.catalogId === c.id)) throw new PluginError(t("agent.pluginInstalled"));
      record = { id: c.id, catalogId: c.id, name: c.name, enabled: true, approval: c.defaultApproval, secrets: this.secretsFrom(c.secrets ?? [], raw.secrets), addedAt: Date.now() };
    }
    this.records.push(record);
    this.save();
    return this.view(record);
  }

  update(id: string, raw: any): PluginView {
    const r = this.get(id);
    if (typeof raw?.enabled === "boolean") r.enabled = raw.enabled;
    if (raw?.approval === "ask" || raw?.approval === "auto") r.approval = raw.approval;
    if (raw?.secrets !== undefined && !r.custom) {
      r.secrets = this.secretsFrom(this.specOf(r)?.fields ?? [], raw.secrets, r.secrets);
      delete r.lastTest;
    }
    this.save();
    return this.view(r);
  }

  remove(id: string): void {
    this.get(id);
    this.records = this.records.filter((x) => x.id !== id);
    this.save();
  }

  /** 本机插件用 npx 运行：PATH 里有没有它（查一次记一分钟） */
  nodeAvailable(): boolean {
    if (this.npx && Date.now() - this.npx.at < 60_000) return this.npx.ok;
    const names = process.platform === "win32" ? ["npx.cmd", "npx.exe", "npx"] : ["npx"];
    const ok = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).some((dir) => names.some((n) => fs.existsSync(path.join(dir, n))));
    this.npx = { at: Date.now(), ok };
    return ok;
  }

  /**
   * 实际连一次：握手、列出工具，然后断开。结果记在这条插件上（界面显示工具数或出错原因）。
   * 本机插件第一次要下载包，给足 3 分钟；顺带也把 npx 的缓存热好，代理启动时就不用再等下载。
   */
  async test(id: string): Promise<PluginTestResult> {
    const r = this.get(id);
    const p = this.resolve(r);
    const t0 = Date.now();
    const done = (result: Omit<PluginTestResult, "at" | "ms">): PluginTestResult => {
      const full = { ...result, at: Date.now(), ms: Date.now() - t0 };
      r.lastTest = full;
      this.save();
      return full;
    };
    if (!p) return done({ ok: false, tools: [], error: t("agent.pluginNeedsSetup") });
    const runtime = this.o.runtimeDir?.();
    if (!runtime) return done({ ok: false, tools: [], error: t("agent.pluginNoRuntime") });
    if (p.transport === "stdio" && p.command === NPX && !this.nodeAvailable()) return done({ ok: false, tools: [], error: t("agent.pluginNoNode") });
    let client: any;
    try {
      const dist = path.join(runtime, "node_modules", "@modelcontextprotocol", "client", "dist");
      const sdk: any = await import(pathToFileURL(path.join(dist, "index.mjs")).href);
      let transport: any;
      if (p.transport === "http") {
        const headers = Object.fromEntries(Object.entries(p.headers ?? {}).filter(([, v]) => usable(v, p.secrets)).map(([k, v]) => [k, render(v, p.secrets)]));
        const custom = this.o.fetch?.();
        transport = new sdk.StreamableHTTPClientTransport(new URL(render(p.url ?? "", p.secrets, true)), { requestInit: { headers }, ...(custom ? { fetch: custom } : {}) });
      } else {
        const stdio: any = await import(pathToFileURL(path.join(dist, "stdio.mjs")).href);
        const env = Object.fromEntries(Object.entries(p.env ?? {}).filter(([, v]) => usable(v, p.secrets)).map(([k, v]) => [k, render(v, p.secrets)]));
        transport = new stdio.StdioClientTransport({ command: p.command, args: p.args ?? [], env: { ...stdio.getDefaultEnvironment?.(), ...env }, stderr: "ignore" });
      }
      client = new sdk.Client({ name: "dazuibot", version: "1" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
      const limit = p.transport === "stdio" ? 180_000 : 30_000;
      let timer: NodeJS.Timeout | undefined;
      const tools = await Promise.race([
        (async () => {
          await client.connect(transport);
          const listed = await client.listTools();
          return (listed?.tools ?? []).map((x: { name?: unknown }) => String(x.name ?? "")).filter(Boolean) as string[];
        })(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(t("agent.pluginTestTimeout", { s: Math.round(limit / 1000) }))), limit))),
      ]).finally(() => clearTimeout(timer));
      return done({ ok: true, tools: tools.slice(0, 60) });
    } catch (e) {
      // 出错信息里可能带着地址（含 Key）：把这条插件的密钥都抹掉再存、再显示
      let message = String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 300);
      for (const v of Object.values(p.secrets)) if (v) message = message.split(v).join("***").split(encodeURIComponent(v)).join("***");
      return done({ ok: false, tools: [], error: message });
    } finally {
      await Promise.resolve(client?.close?.()).catch(() => undefined);
    }
  }
}
