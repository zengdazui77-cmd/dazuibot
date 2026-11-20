/**
 * Web 端团队界面的端到端验收。
 *
 * 用无头 Chrome 真的走一遍：登录 → 建团队 → 接入模型 → 发消息 →
 * 模型授权 → 成员自选模型 → 策略告警/指标 → 各标签页渲染 → 控制台无报错。
 *
 * 用法：
 *   node scripts/web-e2e.mjs              # 自己起服务，跑完再关掉
 *   node scripts/web-e2e.mjs <baseUrl>    # 打到已经在跑的服务上
 *
 * 环境变量：
 *   CHROME_PATH   Chrome/Edge 可执行文件路径（找不到就直接跳过并说明原因）
 *   E2E_OUT       结果输出文件（默认 web-e2e.txt）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const PORT = Number(process.env.E2E_CDP_PORT ?? 9463);
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), "dazuibot-web-e2e.txt");
let BASE = process.argv[2] || "http://127.0.0.1:8790";

if (!CHROME) {
  console.log("跳过：找不到 Chrome/Edge。装好后用 CHROME_PATH 指定路径再跑。");
  process.exit(0);
}

const profile = path.join(os.tmpdir(), "dz-web-e2e");
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

const out = [];
const log = (s) => { out.push(String(s)); fs.writeFileSync(OUT, out.join("\n")); console.log(s); };
const cleanup = [];

// 没给 baseUrl 就自己起一个内嵌团队服务，跑完再关掉。
let server = null;
if (!process.argv[2]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dz-web-e2e-data-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const mod = await import("../src/embedded.js");
  server = await mod.startEmbeddedTeamService({
    dataDir, host: "127.0.0.1", port: 0,
    modelCatalog: ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4"],
    allowDevCodes: true,
  });
  BASE = server.url;
  log("已启动内嵌团队服务：" + server.url);
}

// CI 上是以 root 跑的，Chrome 的沙箱起不来，必须加 --no-sandbox。
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--no-sandbox", "--disable-dev-shm-usage",
  "about:blank",
], { stdio: "ignore" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL = `e2e${Date.now()}@example.com`;
const LIT = JSON.stringify(EMAIL);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
        if (m.method === "Page.javascriptDialogOpening") this.send("Page.handleJavaScriptDialog", { accept: true });
      }
    };
  }
  async connect() { await new Promise((r) => { this.ws.onopen = r; }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      return "EXC:" + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200);
    }
    return r.result.value;
  }
}

const click = (sel) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return "缺少 "+${JSON.stringify(sel)};e.click();return "ok";})()`;
const setVal = (sel, val) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return "缺少 "+${JSON.stringify(sel)};e.value=${JSON.stringify(val)};e.dispatchEvent(new Event("input",{bubbles:true}));return "ok";})()`;
const tab = (t) => `(()=>{const b=[...document.querySelectorAll("[data-tab]")].find(x=>x.dataset.tab==="${t}");if(!b)return "缺少 tab ${t}";b.click();return "ok";})()`;

try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
    await wait(500);
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + "/")}`, { method: "PUT" })).json();
  const cdp = new Cdp(new WebSocket(target.webSocketDebuggerUrl));
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  // /json/new 是带 URL 打开的，首个响应可能在 Network.enable 之前就完成了；
  // 这里重新导航一次，保证能拿到完整的响应头。
  await cdp.send("Page.navigate", { url: BASE + "/" });
  await wait(2500);

  // 真实响应头走 Network.responseReceivedExtraInfo 才拿得到；
  // responseReceived 里只有一部分头，而且首个响应未必是 "/"。
  const extra = cdp.events.filter((e) => e.method === "Network.responseReceivedExtraInfo")
    .map((e) => e.params.headers?.["content-security-policy"] || e.params.headers?.["Content-Security-Policy"])
    .filter(Boolean);
  log("=== 0. 响应头 ===");
  log("CSP: " + (extra[0] ?? "(无)"));

  log("=== 1. 登录 ===");
  log("页面: " + await cdp.eval(`document.title`));
  log("填邮箱: " + await cdp.eval(setVal("#email", EMAIL)));
  log("点发送验证码: " + await cdp.eval(click("#send")));
  await wait(1200);
  let code = "";
  for (let i = 0; i < 40; i++) {
    code = String(await cdp.eval(`document.querySelector("#code")?.value || ""`));
    if (/^\d{6}$/.test(code)) break;
    await wait(250);
  }
  log("验证码: " + (code || "(未自动填充)"));
  if (!/^\d{6}$/.test(code)) { log("验证码没出来，停止"); throw new Error("no dev code"); }
  log("点登录: " + await cdp.eval(click("#signin")));
  await wait(2500);
  log("登录后提示: " + await cdp.eval(`document.querySelector("#notice")?.textContent||"-"`));
  log("是否进入应用: " + await cdp.eval(`!!document.querySelector("[data-tab]")`));

  log("=== 2. 建团队 ===");
  log("填团队名: " + await cdp.eval(setVal("#team-name", "WebTeam")));
  log("点创建: " + await cdp.eval(click("#create-team")));
  await wait(2500);
  log("团队数: " + await cdp.eval(`document.querySelectorAll("#team-select option").length`));
  log("提示: " + await cdp.eval(`document.querySelector("#notice")?.textContent||"-"`));

  log("=== 3. 建机器人 ===");
  log(await cdp.eval(setVal("#bot-name", "CodeBot")));
  log(await cdp.eval(click("#new-bot")));
  await wait(2000);
  log("机器人: " + await cdp.eval(`JSON.stringify([...document.querySelectorAll("#bot option")].map(o=>o.textContent))`));

  log("=== 4. 建讨论 ===");
  log(await cdp.eval(setVal("#convo-title", "第一条讨论")));
  log(await cdp.eval(click("#new-convo")));
  await wait(2000);
  log("讨论: " + await cdp.eval(`JSON.stringify([...document.querySelectorAll("#convo option")].map(o=>o.textContent))`));

  log("=== 5. 接入模型 ===");
  log(await cdp.eval(tab("model")));
  await wait(500);
  log(await cdp.eval(setVal("#model-name", "gpt-4o")));
  log(await cdp.eval(setVal("#model-key", "sk-test-local")));
  log(await cdp.eval(click("#save-model-config")));
  await wait(2000);
  log("提示: " + await cdp.eval(`document.querySelector("#notice")?.textContent||"-"`));

  log("=== 6. 发消息 ===");
  log(await cdp.eval(tab("chat")));
  await wait(600);
  log(await cdp.eval(setVal("#draft", "你好，团队")));
  log(await cdp.eval(click("#send-msg")));
  await wait(2500);
  log("消息区: " + await cdp.eval(`document.querySelector("#chat")?.innerText.replace(/\\s+/g," ").slice(0,200)||"-"`));

  log("=== 7. 模型授权（指定模型）===");
  log(await cdp.eval(tab("policy")));
  await wait(600);
  log(await cdp.eval(`(()=>{const s=document.querySelector("#policy-mode");if(!s)return "无模式下拉";s.value="allowlist";s.dispatchEvent(new Event("change",{bubbles:true}));return "已选 allowlist";})()`));
  await wait(400);
  log("输入框存在: " + await cdp.eval(`!!document.querySelector("#policy-models")`));
  log(await cdp.eval(setVal("#policy-models", "gpt-4o,claude-3-5-sonnet")));
  log(await cdp.eval(click("#save-policy")));
  await wait(1800);
  log("提示: " + await cdp.eval(`document.querySelector("#notice")?.textContent||"-"`));
  log("回读: " + await cdp.eval(`(async()=>{const r=await fetch("/v1/teams/"+state.teamId+"/model-policy",{headers:{authorization:"Bearer "+state.token}});return await r.text();})()`));

  log("=== 8. 成员自选模型 ===");
  log(await cdp.eval(tab("policy")));
  await wait(500);
  log(await cdp.eval(setVal("#my-model-text", "claude-3-5-sonnet")));
  log(await cdp.eval(click("#save-model")));
  await wait(1800);
  log("提示: " + await cdp.eval(`document.querySelector("#notice")?.textContent||"-"`));

  log("=== 9. 策略告警与指标 ===");
  log(await cdp.eval(tab("rules")));
  await wait(900);
  log("告警卡片: " + await cdp.eval(`(()=>{const c=[...document.querySelectorAll(".card h2")].map(h=>h.textContent);return JSON.stringify(c);})()`));
  log("告警接口: " + await cdp.eval(`(async()=>{const r=await fetch("/v1/teams/"+state.teamId+"/model-policy-alerts",{headers:{authorization:"Bearer "+state.token}});return await r.text();})()`));
  log("指标接口: " + await cdp.eval(`(async()=>{const r=await fetch("/v1/teams/"+state.teamId+"/model-policy-metrics?period=hour",{headers:{authorization:"Bearer "+state.token}});return await r.text();})()`));

  log("=== 10. 各标签页渲染 ===");
  for (const t of ["chat", "members", "model", "policy", "rules", "usage", "audit"]) {
    await cdp.eval(tab(t));
    await wait(800);
    log(`[${t}] ` + await cdp.eval(`document.querySelector("#app").innerText.replace(/\\s+/g," ").slice(0,160)`));
  }

  log("=== 11. 控制台 ===");
  const errs = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
  log(errs.length ? "未捕获异常:\n" + errs.join("\n") : "(无未捕获异常)");
  const cerr = cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
    .map((e) => e.params.args.map((a) => a.value || a.description).join(" "));
  log(cerr.length ? "console.error:\n" + cerr.join("\n") : "(无 console.error)");
} catch (e) {
  log("ERR " + e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  if (server) await server.close();
  for (const fn of cleanup) { try { fn(); } catch {} }
}
