/** 插件社区：目录、安装与密钥、写进 DSH 补丁的条目、审批闸门。 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, PLUGIN_TOOL_PREFIX, PluginService, pluginPatch, pluginSignature, type ResolvedPlugin } from "../src/agent/plugins.js";
import { RULE_DENY_PREFIX } from "../src/tasks/rules.js";

const kv = () => {
  const m = new Map<string, string>();
  return { getKV: (k: string) => m.get(k), setKV: (k: string, v: string) => void m.set(k, v), raw: m };
};
const gate = "/rt/plugins/amb-plugin-gate.mjs";

describe("plugin catalog", () => {
  it("every entry is connectable as declared and names the secrets its templates use", () => {
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length);
    for (const c of CATALOG) {
      expect(c.id).toMatch(/^[a-z0-9-]{1,28}$/);
      if (c.transport === "http") expect(c.url).toMatch(/^https:\/\//);
      else expect(c.command).toBeTruthy();
      const templates = [c.url ?? "", ...Object.values(c.headers ?? {}), ...Object.values(c.env ?? {})].join(" ");
      const used = [...templates.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
      expect(used.sort()).toEqual((c.secrets ?? []).map((s) => s.key).sort());
      // 参数里不放密钥（进程列表看得见）
      expect((c.args ?? []).join(" ")).not.toMatch(/\{/);
    }
  });
});

describe("plugin service", () => {
  it("installs from the catalog, requires its key, and never returns a secret", () => {
    const store = kv();
    const s = new PluginService({ kv: store });
    expect(() => s.install({ id: "amap" })).toThrow();
    expect(() => s.install({ id: "nope" })).toThrow();
    const view = s.install({ id: "amap", secrets: { key: "amap-secret-123" } });
    expect(view).toMatchObject({ id: "amap", enabled: true, approval: "auto", needsSetup: false, secretsSet: ["key"], target: "mcp.amap.com" });
    expect(JSON.stringify(s.list())).not.toContain("amap-secret-123");
    expect(() => s.install({ id: "amap", secrets: { key: "x" } })).toThrow();
    // 可选的 Key 不填也能装
    expect(s.install({ id: "context7" }).needsSetup).toBe(false);
    // 重启后还在
    expect(new PluginService({ kv: store }).list().map((p) => p.id)).toEqual(["amap", "context7"]);
    expect(s.runtime().map((p) => p.server)).toEqual(["plg-amap", "plg-context7"]);
    s.update("amap", { enabled: false, approval: "ask" });
    expect(s.runtime().map((p) => p.id)).toEqual(["context7"]);
    expect(s.list()[0]).toMatchObject({ enabled: false, approval: "ask" });
    // 改 Key：留空的不动
    s.update("amap", { secrets: {} });
    expect(s.list()[0]!.secretsSet).toEqual(["key"]);
    s.remove("amap");
    expect(s.list().map((p) => p.id)).toEqual(["context7"]);
    expect(() => s.remove("amap")).toThrow();
  });

  it("custom plugins: HTTPS only for remote servers, env values kept as secrets, asks by default", () => {
    const s = new PluginService({ kv: kv() });
    expect(() => s.install({ custom: { name: "x", transport: "http", url: "http://example.com/mcp" } })).toThrow();
    expect(() => s.install({ custom: { name: "x", transport: "http", url: "https://user:pw@example.com/mcp" } })).toThrow();
    expect(() => s.install({ custom: { name: "", transport: "http", url: "https://example.com/mcp" } })).toThrow();
    expect(() => s.install({ custom: { name: "x", transport: "stdio", command: "npx", env: { "BAD NAME": "v" } } })).toThrow();
    const remote = s.install({ custom: { name: "Mine", transport: "http", url: "https://example.com/mcp?token=tok-456", authorization: "Bearer abc-789" } });
    expect(remote).toMatchObject({ custom: true, approval: "ask", transport: "http", target: "example.com" });
    const local = s.install({ custom: { name: "Local", transport: "stdio", command: "npx", args: ["-y", "some-server"], env: { API_KEY: "local-secret" } } });
    expect(local).toMatchObject({ transport: "stdio", target: "npx -y some-server" });
    const text = JSON.stringify(s.list());
    for (const secret of ["tok-456", "abc-789", "local-secret"]) expect(text).not.toContain(secret);
    expect(s.install({ custom: { name: "Dev", transport: "http", url: "http://127.0.0.1:3000/mcp" } }).target).toBe("127.0.0.1:3000");
  });
});

describe("plugin entries in the DSH patch", () => {
  const amap: ResolvedPlugin = { id: "amap", server: "plg-amap", transport: "http", url: "https://mcp.amap.com/mcp?key={key}", secrets: { key: "a b&c" }, approval: "auto" };
  const context7: ResolvedPlugin = { id: "context7", server: "plg-context7", transport: "http", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: "{key}" }, secrets: {}, approval: "auto" };
  const fire: ResolvedPlugin = { id: "firecrawl", server: "plg-firecrawl", transport: "stdio", command: "npx", args: ["-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY: "{key}" }, secrets: { key: "fc-secret" }, approval: "ask" };

  it("secrets travel only in the environment; the patch refers to them", () => {
    const r = pluginPatch([amap, context7, fire], { gate });
    const text = r.lines.join("\n");
    expect(text).not.toContain("a b&c");
    expect(text).not.toContain("fc-secret");
    expect(r.env).toMatchObject({ AMB_PLUGIN_SECRET_0: "a b&c", AMB_PLUGIN_SECRET_1: "fc-secret", AMB_PLUGIN_ASK: JSON.stringify(["plg-firecrawl"]) });
    expect(text).toContain("    - id: amb-plugin-amap\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: streamable-http\n        serverName: plg-amap\n");
    // 嵌在地址里的 Key 做 URL 编码
    expect(text).toContain(`        url: !!js ${JSON.stringify('"https://mcp.amap.com/mcp?key=" + encodeURIComponent(process.env.AMB_PLUGIN_SECRET_0)')}\n`);
    // 没填的可选 Key：那个请求头整个不发
    expect(text).toContain('        serverName: plg-context7\n        url: "https://mcp.context7.com/mcp"\n        toolCallTimeoutMs');
    expect(text).toContain(`        transport: stdio\n        serverName: plg-firecrawl\n        command: "npx"\n        args: ["-y", "firecrawl-mcp"]\n        env:\n          "FIRECRAWL_API_KEY": !!js "process.env.AMB_PLUGIN_SECRET_1"\n`);
    // 连不上不拦着代理启动
    expect(text.match(/failOnStartupError: false/g)).toHaveLength(3);
    expect(text.endsWith(`    - id: amb-plugin-gate\n      name: ${JSON.stringify(gate)}`)).toBe(true);
  });

  it("a custom server address is used as given, and read-only bots ask for every plugin", () => {
    const custom: ResolvedPlugin = { id: "c-1", server: "plg-c-1", transport: "http", url: "{url}", headers: { Authorization: "{authorization}" }, secrets: { url: "https://example.com/mcp?token=t%201" }, approval: "auto" };
    const r = pluginPatch([custom], { gate });
    expect(r.lines.join("\n")).toContain('        url: !!js "process.env.AMB_PLUGIN_SECRET_0"\n');
    expect(r.lines.join("\n")).not.toMatch(/headers:|amb-plugin-gate/);
    expect(r.env.AMB_PLUGIN_ASK).toBe("[]");
    const forced = pluginPatch([custom], { gate, forceAsk: true });
    expect(forced.env.AMB_PLUGIN_ASK).toBe(JSON.stringify(["plg-c-1"]));
    expect(forced.lines.join("\n")).toContain("amb-plugin-gate");
    expect(pluginPatch([], { gate })).toEqual({ lines: [], env: {} });
  });

  it("the signature changes with the set and with a key, so idle agent processes restart", () => {
    expect(pluginSignature([])).toBe("");
    const a = pluginSignature([amap]);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(pluginSignature([{ ...amap, secrets: { key: "other" } }])).not.toBe(a);
    expect(pluginSignature([amap, context7])).not.toBe(a);
  });

  it("rule sessions get no plugin tools", () => {
    expect(PLUGIN_TOOL_PREFIX).toBe("mcp__plg-");
    expect(RULE_DENY_PREFIX).toContain(PLUGIN_TOOL_PREFIX);
  });
});

describe("plugin approval gate", () => {
  const plugin = path.join(__dirname, "..", "dsh-runtime", "plugins", "amb-plugin-gate.mjs");
  const run = async (ask: string | undefined, tool: string, downstream: { kind: string } = { kind: "allow" }) => {
    const prev = process.env.AMB_PLUGIN_ASK;
    if (ask === undefined) delete process.env.AMB_PLUGIN_ASK;
    else process.env.AMB_PLUGIN_ASK = ask;
    let hook: any;
    const mod = await import(plugin + `?t=${Math.random()}`);
    mod.apply({ on: (_ev: string, fn: any) => (hook = fn) });
    if (prev === undefined) delete process.env.AMB_PLUGIN_ASK;
    else process.env.AMB_PLUGIN_ASK = prev;
    return hook ? hook({ name: tool }, async () => downstream) : { kind: "allow", noHook: true };
  };

  it("asks only for the listed plugins and never loosens another decision", async () => {
    expect(await run(undefined, "mcp__plg-github__create_issue")).toMatchObject({ noHook: true });
    expect(await run("[]", "mcp__plg-github__create_issue")).toMatchObject({ noHook: true });
    const asked = await run('["plg-github"]', "mcp__plg-github__create_issue");
    expect(asked.kind).toBe("ask");
    expect(asked.displayReason.zh).toBe("插件 github：create_issue");
    expect((await run('["plg-github"]', "mcp__plg-exa__web_search_exa")).kind).toBe("allow");
    expect((await run('["plg-github"]', "mcp__plg-github2__x")).kind).toBe("allow");
    expect((await run('["plg-github"]', "read_file")).kind).toBe("allow");
    expect((await run('["plg-github"]', "mcp__plg-github__create_issue", { kind: "deny" })).kind).toBe("deny");
  });
});
