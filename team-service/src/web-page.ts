import { randomBytes } from "node:crypto";

/**
 * 团队服务的 Web 界面：浏览器里直接打开团队地址就能用。
 *
 * 为什么放在团队服务里而不是另建前端项目：
 *   - 同源，不用管跨域和会话令牌的传递；
 *   - 跟着团队服务一起部署，运维只要跑一个东西；
 *   - 桌面端 App 里的团队功能仍然是主入口，Web 版给「不方便装桌面端的人」用。
 *
 * 这个页面只做纯云端的事：登录、团队、成员、共享聊天、模型授权、用量、审计。
 * 依赖本机 Git 的部分（克隆仓库、开本地工作区、看本地改动、提 PR）只在桌面端有。
 */

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f6f4; --surface: #fff; --well: #f0efec; --line: #e3e2de; --line-2: #d6d5d0;
  --fg: #1d1d1b; --fg-2: #4a4a46; --muted: #78776f; --primary: #2f6df6; --on-primary: #fff;
  --danger: #c0392b; --green: #1f8a4c; --amber: #b7791f;
  --r: 10px; --r-sm: 6px;
  --space: 8px; --sp: 4px;
  --shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06);
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#17171a; --surface:#1e1e22; --well:#242429; --line:#2c2c32; --line-2:#3a3a42;
    --fg:#ececed; --fg-2:#c3c3c8; --muted:#8e8e98; --primary:#6c9bff; --on-primary:#10131c;
    --danger:#ff8b7d; --green:#5fd39a; --amber:#e0b055; --shadow:0 1px 3px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.3); }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
a { color: var(--primary); }
button { font: inherit; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 24px 20px 64px; }
header.top { display:flex; align-items:center; gap:12px; margin-bottom:20px; }
header.top h1 { font-size:18px; margin:0; }
header.top .sp { flex:1; }
.card { background:var(--surface); border-radius:var(--r); box-shadow:var(--shadow); padding:16px; margin-bottom:16px; }
.card > h2 { font-size:14px; margin:0 0 12px; color:var(--fg-2); font-weight:600; }
.row { display:flex; gap:var(--space); align-items:center; flex-wrap:wrap; }
.grow { flex:1; min-width:0; }
label { display:block; font-size:12px; color:var(--muted); margin-bottom:var(--sp); }
input, select, textarea { width:100%; padding:8px 10px; border:1px solid var(--line-2); border-radius:var(--r-sm);
  background:var(--surface); color:var(--fg); font:inherit; }
input:focus, select:focus, textarea:focus { outline:2px solid var(--primary); outline-offset:1px; }
.btn { padding:8px 14px; border:0; border-radius:var(--r-sm); background:var(--well); color:var(--fg); cursor:pointer; }
.btn:hover { background:var(--line); }
.btn.primary { background:var(--primary); color:var(--on-primary); }
.btn.danger { color:var(--danger); background:transparent; }
.btn:disabled { opacity:.5; cursor:default; }
.notice { padding:10px 12px; border-radius:var(--r-sm); margin-bottom:12px; }
.notice.err { background:color-mix(in srgb, var(--danger) 12%, var(--surface)); color:var(--danger); }
.notice.ok { background:color-mix(in srgb, var(--green) 12%, var(--surface)); color:var(--green); }
.pill { display:inline-block; padding:1px 8px; border-radius:99px; background:var(--well); color:var(--muted); font-size:12px; }
.list { display:grid; gap:8px; }
.item { display:flex; gap:var(--space); align-items:center; padding:8px 10px; background:var(--well); border-radius:var(--r-sm); }
.item .grow { overflow-wrap:anywhere; }
.msg { padding:8px 10px; border-radius:var(--r-sm); background:var(--well); }
.msg.me { background:color-mix(in srgb, var(--primary) 10%, var(--surface)); }
.msg .who { font-size:12px; color:var(--muted); margin-bottom:2px; }
.chat { display:grid; gap:8px; max-height:420px; overflow:auto; padding:4px; }
.empty { color:var(--muted); padding:12px; text-align:center; }
.tabs { display:flex; gap:var(--sp); margin-bottom:12px; flex-wrap:wrap; }
.tabs button { padding:6px 12px; border-radius:99px; border:1px solid var(--line-2); background:var(--surface); color:var(--fg-2); cursor:pointer; }
.tabs button[aria-selected="true"] { background:var(--primary); color:var(--on-primary); border-color:var(--primary); }
pre { background:var(--well); padding:10px; border-radius:var(--r-sm); overflow:auto; font-size:12px; }
.chk { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--fg-2); margin-bottom:4px; }
.chk input { width:auto; }
`;

const SCRIPT = String.raw`
const $ = (sel, root) => (root || document).querySelector(sel);
const state = { token: localStorage.getItem("team-token") || "", user: null, teams: [], teamId: localStorage.getItem("team-id") || "",
  tab: "chat", policy: null, members: [], usage: null, audit: [], conversations: [], bots: [],
  rules: [], violations: [], modelConfig: null,
  activeConversation: "", messages: [], jobs: [], notice: "" };

function say(text, kind) {
  const el = $("#notice");
  if (!el) return;
  el.className = "notice " + (kind || "ok");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || "GET",
    headers: { "content-type": "application/json", ...(state.token ? { authorization: "Bearer " + state.token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || ("HTTP " + res.status)); e.status = res.status; throw e; }
  return data;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// —— 登录 ——
async function loadStatus() {
  const me = await api("/v1/me");
  state.user = me.user;
  state.teams = me.teams || [];
  if (!state.teams.some((t) => t.id === state.teamId)) state.teamId = state.teams[0] ? state.teams[0].id : "";
  localStorage.setItem("team-id", state.teamId);
}

async function login(email, code) {
  // 不要再调 /v1/auth/codes：验证码已由「发送验证码」按钮申请过，
  // 服务端对同一邮箱有 60 秒冷却，再申请会直接 429。
  const r = await api("/v1/auth/sessions", "POST", { email, code });
  state.token = r.token;
  localStorage.setItem("team-token", r.token);
  await loadStatus();
  render();
}

// —— 团队数据 ——
async function loadTeam() {
  if (!state.teamId) { render(); return; }
  const id = encodeURIComponent(state.teamId);
  const [policy, members, usage, audit, convos, bots, rules, violations, modelConfig] = await Promise.all([
    api("/v1/teams/" + id + "/model-policy").catch(() => null),
    api("/v1/teams/" + id + "/members").then((r) => r.members || []).catch(() => []),
    api("/v1/teams/" + id + "/usage").then((r) => r.usage).catch(() => null),
    api("/v1/teams/" + id + "/audit").then((r) => r.events || []).catch(() => []),
    api("/v1/teams/" + id + "/conversations").then((r) => r.conversations || []).catch(() => []),
    api("/v1/teams/" + id + "/bots").then((r) => r.bots || []).catch(() => []),
    api("/v1/teams/" + id + "/model-policy-rules").then((r) => r.rules || []).catch(() => []),
    api("/v1/teams/" + id + "/model-policy-violations").then((r) => r.violations || []).catch(() => []),
    api("/v1/teams/" + id + "/model-config").then((r) => r.modelConfig).catch(() => null),
  ]);
  state.policy = policy ? policy.modelPolicy : null;
  state.members = members; state.usage = usage; state.audit = audit;
  state.rules = rules; state.violations = violations;
  state.conversations = convos; state.bots = bots;
  state.modelConfig = modelConfig;
  if (!state.conversations.some((c) => c.id === state.activeConversation)) state.activeConversation = state.conversations[0] ? state.conversations[0].id : "";
  if (state.activeConversation) await loadMessages();
  else state.messages = []; state.jobs = [];
}

async function loadMessages() {
  if (!state.teamId || !state.activeConversation) return;
  const id = encodeURIComponent(state.teamId);
  const cid = encodeURIComponent(state.activeConversation);
  const r = await api("/v1/teams/" + id + "/conversations/" + cid + "/messages");
  state.messages = r.messages || [];
  state.jobs = r.jobs || [];
}

// —— 渲染 ——
function renderLogin() {
  return '<div class="card"><h2>登录团队</h2>' +
    '<div class="row"><div class="grow"><label>邮箱</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com"></div></div>' +
    '<div class="row" style="margin-top:8px"><div class="grow"><label>邮箱验证码</label><input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>' +
    '<button class="btn" id="send">发送验证码</button><button class="btn primary" id="signin">登录</button></div>' +
    '<p class="pill" style="margin-top:10px">开发模式下验证码会直接显示在这里</p></div>';
}

function renderTeams() {
  if (!state.teams.length) return '<div class="card"><h2>还没有团队</h2><div class="row"><div class="grow"><input id="team-name" placeholder="团队名称"></div><button class="btn primary" id="create-team">创建团队</button></div></div>';
  return '<div class="card"><h2>团队</h2><div class="row"><select id="team-select" class="grow">' +
    state.teams.map((t) => '<option value="' + esc(t.id) + '"' + (t.id === state.teamId ? " selected" : "") + ">" + esc(t.name) + " · " + esc(t.role) + "</option>").join("") +
    '</select></div></div>';
}

function renderTabs() {
  const tabs = [["chat", "共享聊天"], ["members", "成员"], ["model", "模型接入"], ["policy", "模型授权"], ["rules", "额外限制"], ["usage", "用量"], ["audit", "审计"]];
  return '<div class="tabs">' + tabs.map(([k, label]) =>
    '<button role="tab" data-tab="' + k + '" aria-selected="' + (state.tab === k) + '">' + label + "</button>").join("") + "</div>";
}

// 团队模型接入：没有它，团队发消息会被服务端挡下来（"The team model is not configured"）。
function renderModel() {
  const cfg = state.modelConfig;
  const canManage = ["owner", "admin"].includes((state.teams.find((t) => t.id === state.teamId) || {}).role);
  if (!cfg) return '<div class="card"><h2>模型接入</h2><div class="empty">读不到模型接入状态</div></div>';
  const endpoint = cfg.modelBaseUrl ? '<div class="pill">模型网关：' + esc(cfg.modelBaseUrl) + "</div>" : "";
  if (cfg.configured) {
    const rotate = canManage
      ? '<div class="row" style="margin-top:12px"><input id="model-key" type="password" class="grow" placeholder="换新的 API Key（留空表示不改）">' +
        '<button class="btn" id="rotate-key">更新 Key</button></div>'
      : "";
    return '<div class="card"><h2>模型接入</h2>' + endpoint +
      '<div class="row" style="margin-top:12px"><span class="grow">默认模型 <strong>' + esc(cfg.model) + "</strong></span>" +
      (cfg.keyTail ? '<span class="pill">Key ····' + esc(cfg.keyTail) + "</span>" : "") + "</div>" + rotate + "</div>";
  }
  if (!canManage) return '<div class="card"><h2>模型接入</h2>' + endpoint + '<div class="empty">团队还没配置模型，请让团队创建者接入</div></div>';
  return '<div class="card"><h2>模型接入</h2>' + endpoint +
    '<div class="row" style="margin-top:12px"><input id="model-name" class="grow" placeholder="模型标识，例如 gpt-4o">' +
    '<input id="model-key" type="password" class="grow" placeholder="模型 API Key"></div>' +
    '<div class="row" style="margin-top:8px"><button class="btn primary" id="save-model-config">保存</button></div></div>';
}

function renderChat() {
  const convos = state.conversations.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === state.activeConversation ? " selected" : "") + ">" + esc(c.title) + "</option>").join("");
  const bots = state.bots.map((b) => '<option value="' + esc(b.id) + '">' + esc(b.name) + "</option>").join("");
  const msgs = state.messages.length
    ? state.messages.map((m) => '<div class="msg' + (m.role === "user" ? " me" : "") + '"><div class="who">' +
        esc(m.authorEmail || "AI") + '</div><div>' + esc(m.content) + "</div></div>").join("")
    : '<div class="empty">还没有消息</div>';
  const jobs = state.jobs.length
    ? '<div class="row" style="margin-top:8px">' + state.jobs.slice(0, 3).map((j) => '<span class="pill">' + esc(j.status) + (j.errorCode ? " · " + esc(j.errorCode) : "") + "</span>").join("") + "</div>"
    : "";
  // 讨论必须挂在一个团队机器人上：没有机器人时，聊天这条路走不通，
  // 所以这里把「新建机器人」摆在最前面，而不是让人卡在一句报错上。
  const canManage = ["owner", "admin"].includes((state.teams.find((t) => t.id === state.teamId) || {}).role);
  const botPanel = state.bots.length
    ? '<div class="row"><select id="bot" style="max-width:200px">' + bots + "</select>" +
      (canManage ? '<button class="btn" id="new-bot">新建机器人</button>' : "") + "</div>"
    : '<div class="row">' +
      (canManage
        ? '<div class="grow"><input id="bot-name" placeholder="机器人名称，例如「代码助手」"><input id="bot-instructions" placeholder="给它的指令（可留空）"></div>' +
          '<button class="btn primary" id="new-bot">新建机器人</button>'
        : '<span class="pill">团队还没有机器人，请让团队创建者先建一个</span>') + "</div>";
  // 新建讨论用行内输入框，不用系统 prompt 对话框：
  // 对话框在浏览器里会打断操作，也没法在自动化测试里填。
  const convoPanel = state.conversations.length
    ? '<div class="row"><select id="convo" class="grow">' + convos + '</select>' +
      (canManage ? '<button class="btn" id="new-convo">新建讨论</button>' : "") + "</div>"
    : '<div class="row">' +
      (canManage && state.bots.length
        ? '<div class="grow"><input id="convo-title" placeholder="讨论标题"></div>' +
          '<button class="btn primary" id="new-convo">新建讨论</button>'
        : '<span class="pill">还没有讨论，先新建一个机器人</span>') + "</div>";
  return '<div class="card"><h2>共享聊天</h2>' +
    botPanel +
    '<div class="row" style="margin-top:10px">' + convoPanel + "</div>" +
    '<div class="chat" id="chat">' + msgs + "</div>" + jobs +
    '<div class="row" style="margin-top:10px"><input id="draft" class="grow" placeholder="说点什么…"><button class="btn primary" id="send-msg">发送</button></div></div>';
}

function renderMembers() {
  const rows = state.members.map((m) => '<div class="item"><span class="grow">' + esc(m.email) + '</span><span class="pill">' + esc(m.role) + "</span></div>").join("");
  const canInvite = ["owner", "admin"].includes((state.teams.find((t) => t.id === state.teamId) || {}).role);
  const invite = canInvite
    ? '<div class="row" style="margin-top:12px"><input id="inv-email" class="grow" type="email" placeholder="成员邮箱"><select id="inv-role" style="max-width:160px"><option value="developer">开发者</option><option value="viewer">只读成员</option><option value="admin">管理员</option></select><button class="btn" id="invite">邀请</button></div>'
    : "";
  return '<div class="card"><h2>成员（' + state.members.length + "）</h2>" + (rows || '<div class="empty">还没有成员</div>') + invite + "</div>";
}

function renderPolicy() {
  const p = state.policy;
  if (!p) return '<div class="card"><h2>模型授权</h2><div class="empty">读不到授权设置</div></div>';
  const modes = [["all", "不限制"], ["catalog", "部署模型目录"], ["allowlist", "指定模型"]];
  const canManage = ["owner", "admin"].includes((state.teams.find((t) => t.id === state.teamId) || {}).role);
  const opts = modes.map(([k, label]) => '<option value="' + k + '"' + (p.mode === k ? " selected" : "") + ">" + label + "</option>").join("");
  // 部署目录里的模型给勾选框；目录为空时，「指定模型」必须还能手填，
  // 否则这个模式在没配部署目录的团队里根本没法用。
  const models = (p.catalogModels || []).map((m) => '<label class="chk"><input type="checkbox" data-model="' + esc(m) + '"' +
    ((p.allowedModels || []).includes(m) ? " checked" : "") + ">" + esc(m) + "</label>").join("");
  const avail = (p.availableModels || []).map((m) => '<option value="' + esc(m) + '"' + (p.memberModel === m ? " selected" : "") + ">" + esc(m) + "</option>").join("");
  const allowListPanel = '<div style="margin-top:10px">' +
    (models || '<div class="empty">部署目录为空，直接在下面手填模型标识</div>') +
    '<input id="policy-models" style="margin-top:8px" placeholder="模型标识，多个用逗号分隔">' +
    '<div class="pill" style="margin-top:8px">已选：' + ((p.allowedModels || []).length ? esc((p.allowedModels || []).join("、")) : "无") + "</div></div>";
  const manage = canManage
    ? '<div class="row"><select id="policy-mode" style="max-width:200px">' + opts + "</select>" +
      '<button class="btn primary" id="save-policy">保存</button></div>' +
      (p.mode === "allowlist" ? allowListPanel : "")
    : '<p class="pill">' + esc(p.mode) + "</p>";
  return '<div class="card"><h2>模型授权</h2>' + manage +
    '<div class="row" style="margin-top:12px"><select id="my-model" class="grow"><option value="">跟随团队默认</option>' + avail +
    '</select><input id="my-model-text" style="max-width:220px" placeholder="或手输模型标识" value="' + esc(p.memberModel || "") + '">' +
    '<button class="btn" id="save-model">保存我的选择</button></div>' +
    (p.memberModel ? '<p class="pill" style="margin-top:8px">当前使用：' + esc(p.memberModel) + "</p>" : "") + "</div>";
}

function renderRules() {
  const canManage = ["owner", "admin"].includes((state.teams.find((t) => t.id === state.teamId) || {}).role);
  const rules = (state.rules || []).map((r) => {
    const limits = [];
    if (r.maxRequestsPerUserPerHour) limits.push("每人每小时 " + r.maxRequestsPerUserPerHour + " 次");
    if (r.maxRequestsPerTeamPerHour) limits.push("团队每小时 " + r.maxRequestsPerTeamPerHour + " 次");
    if (r.maxInputTokensPerRequest) limits.push("单次输入 ≤ " + r.maxInputTokensPerRequest + " tokens");
    if (r.maxOutputTokensPerRequest) limits.push("单次输出 ≤ " + r.maxOutputTokensPerRequest + " tokens");
    if (r.maxTotalTokensPerUserPerDay) limits.push("每人每天 ≤ " + r.maxTotalTokensPerUserPerDay + " tokens");
    const models = [];
    if ((r.allowedModels || []).length) models.push("仅限 " + r.allowedModels.join("、"));
    if ((r.blockedModels || []).length) models.push("禁用 " + r.blockedModels.join("、"));
    const roles = (r.appliesToRoles || []).length ? r.appliesToRoles.join("、") : "所有角色";
    const toggle = canManage
      ? '<button class="btn" data-rule-toggle="' + esc(r.id) + '">' + (r.enabled ? "停用" : "启用") + "</button>" +
        '<button class="btn" data-rule-del="' + esc(r.id) + '">删除</button>'
      : "";
    return '<div class="item"><div class="grow"><div><strong>' + esc(r.ruleName) + "</strong> " +
      '<span class="pill">' + (r.enabled ? "生效中" : "已停用") + "</span></div>" +
      '<div class="pill">' + esc(roles) + "</div>" +
      (limits.length ? '<div class="pill">' + esc(limits.join(" · ")) + "</div>" : "") +
      (models.length ? '<div class="pill">' + esc(models.join(" · ")) + "</div>" : "") +
      "</div>" + toggle + "</div>";
  }).join("");
  const form = canManage
    ? '<div class="row" style="margin-top:12px">' +
      '<input id="rule-name" placeholder="规则名称" class="grow">' +
      '<input id="rule-blocked" placeholder="禁用的模型（逗号分隔）" class="grow">' +
      '<input id="rule-rate" placeholder="每人每小时上限" type="number" min="1" style="max-width:150px">' +
      '<button class="btn primary" id="add-rule">添加</button></div>'
    : "";
  const vio = (state.violations || []).slice(0, 20).map((v) => '<div class="item"><span class="grow">' +
    esc(v.ruleName || v.violationType) + '</span><span class="pill">' +
    esc(v.userEmail || "未知") + " · " + esc(v.modelRequested || "") + " · " +
    esc((v.createdAt || "").slice(0, 19).replace("T", " ")) + "</span></div>").join("");
  return '<div class="card"><h2>额外限制</h2>' +
    '<p class="pill">这些规则加在上面的授权范围之上：命中任意一条就会拒绝该次请求。</p>' +
    (rules || '<div class="empty">还没有额外限制</div>') + form + "</div>" +
    '<div class="card"><h2>被拒绝的请求</h2>' + (vio || '<div class="empty">还没有被拒绝的请求</div>') + "</div>";
}

function renderUsage() {
  const u = state.usage;
  if (!u) return '<div class="card"><h2>用量</h2><div class="empty">读不到用量</div></div>';
  const members = (u.members || []).map((m) => '<div class="item"><span class="grow">' + esc(m.email) + '</span><span class="pill">' +
    m.successfulJobs + " 个任务 · " + m.inputTokens + " / " + m.outputTokens + " tokens</span></div>").join("");
  return '<div class="card"><h2>近 30 天用量</h2><div class="item"><span class="grow">合计</span><span class="pill">' +
    u.successfulJobs + " 个任务 · " + u.inputTokens + " / " + u.outputTokens + " tokens</span></div>" +
    (members ? '<div style="margin-top:8px" class="list">' + members + "</div>" : "") +
    '<p class="pill" style="margin-top:10px">只统计模型网关明确返回的 token，用量不等于账单</p></div>';
}

function renderAudit() {
  const rows = state.audit.map((e) => '<div class="item"><span class="grow">' + esc(e.action) + '</span><span class="pill">' +
    esc(e.actorEmail || "系统") + " · " + esc((e.createdAt || "").slice(0, 19).replace("T", " ")) + "</span></div>").join("");
  return '<div class="card"><h2>审计记录</h2>' + (rows || '<div class="empty">还没有记录</div>') + "</div>";
}

function render() {
  const app = $("#app");
  if (!state.token) {
    app.innerHTML = '<div class="wrap">' + '<header class="top"><h1>大嘴助手 · 团队空间</h1></header>' +
      '<div id="notice" class="notice" style="display:none"></div>' + renderLogin() + "</div>";
    bindLogin();
    return;
  }
  const panels = { chat: renderChat, members: renderMembers, model: renderModel, policy: renderPolicy, rules: renderRules, usage: renderUsage, audit: renderAudit };
  app.innerHTML = '<div class="wrap">' +
    '<header class="top"><h1>大嘴助手 · 团队空间</h1><span class="sp"></span>' +
    '<span class="pill">' + esc(state.user ? state.user.email : "") + "</span>" +
    '<button class="btn danger" id="logout">退出</button></header>' +
    '<div id="notice" class="notice" style="display:none"></div>' +
    renderTeams() + renderTabs() + panels[state.tab]() + "</div>";
  bindApp();
  const chat = $("#chat");
  if (chat) chat.scrollTop = chat.scrollHeight;
}

function bindLogin() {
  $("#send").onclick = async () => {
    const email = $("#email").value.trim();
    if (!email) return;
    try {
      const r = await api("/v1/auth/codes", "POST", { email });
      if (r.developmentCode) { $("#code").value = r.developmentCode; say("开发模式验证码：" + r.developmentCode); }
      else say("验证码已发送，请查收邮件");
    } catch (e) { say(e.message, "err"); }
  };
  $("#signin").onclick = async () => {
    try { await login($("#email").value.trim(), $("#code").value.trim()); say("已登录"); }
    catch (e) { say(e.message, "err"); }
  };
}

function bindApp() {
  $("#logout").onclick = async () => {
    try { await api("/v1/auth/sessions/current", "DELETE"); } catch { /* 忽略 */ }
    state.token = ""; localStorage.removeItem("team-token"); render();
  };
  const sel = $("#team-select");
  if (sel) sel.onchange = async () => { state.teamId = sel.value; localStorage.setItem("team-id", state.teamId); await loadTeam(); render(); };
  $("#create-team") && ($("#create-team").onclick = async () => {
    const name = $("#team-name").value.trim();
    if (!name) return;
    try { const r = await api("/v1/teams", "POST", { name }); state.teamId = r.team.id; await loadStatus(); await loadTeam(); render(); say("团队已创建"); }
    catch (e) { say(e.message, "err"); }
  });
  for (const b of document.querySelectorAll("[data-tab]")) b.onclick = async () => { state.tab = b.dataset.tab; render(); };
  const convo = $("#convo");
  if (convo) convo.onchange = async () => { state.activeConversation = convo.value; await loadMessages(); render(); };
  $("#new-bot") && ($("#new-bot").onclick = async () => {
    const name = ($("#bot-name") ? $("#bot-name").value : "").trim();
    if (!name) return say("先给机器人起个名字", "err");
    const instructions = ($("#bot-instructions") ? $("#bot-instructions").value : "").trim();
    try {
      await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/bots", "POST", { name, instructions });
      await loadTeam(); render(); say("机器人已创建");
    } catch (e) { say(e.message, "err"); }
  });
  $("#new-convo") && ($("#new-convo").onclick = async () => {
    const title = ($("#convo-title") ? $("#convo-title").value : "").trim();
    if (!title) return say("先给讨论起个标题", "err");
    const bot = $("#bot") ? $("#bot").value : (state.bots[0] || {}).id;
    if (!bot) return say("先创建一个机器人", "err");
    try { await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/conversations", "POST", { botId: bot, title, visibility: "team" }); await loadTeam(); render(); say("讨论已创建"); }
    catch (e) { say(e.message, "err"); }
  });
  $("#send-msg") && ($("#send-msg").onclick = async () => {
    const draft = $("#draft").value.trim();
    if (!draft) return;
    if (!state.activeConversation) return say("先新建一个讨论", "err");
    try {
      await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/conversations/" + encodeURIComponent(state.activeConversation) + "/messages", "POST", { content: draft });
      await loadMessages(); render();
    } catch (e) { say(e.message, "err"); }
  });
  $("#invite") && ($("#invite").onclick = async () => {
    const email = $("#inv-email").value.trim();
    if (!email) return;
    try {
      const r = await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/invitations", "POST", { email, role: $("#inv-role").value });
      say(r.emailSent ? "邀请已发送" : "邀请已创建：把链接发给对方 " + (r.invitation.inviteUrl || ""));
    } catch (e) { say(e.message, "err"); }
  });
  $("#save-policy") && ($("#save-policy").onclick = async () => {
    const mode = $("#policy-mode").value;
    // 勾选框里的 + 手输的都要算进去：部署目录为空时只剩手输这一条路。
    const checked = [...document.querySelectorAll("[data-model]:checked")].map((c) => c.dataset.model);
    const typed = ($("#policy-models") ? $("#policy-models").value : "").split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const allowed = [...new Set([...checked, ...typed])];
    try { await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/model-policy", "PUT", { mode, allowedModels: allowed }); await loadTeam(); render(); say("授权范围已保存"); }
    catch (e) { say(e.message, "err"); }
  });
  // 切到「指定模型」时把模型输入区露出来，否则用户看不到在哪填。
  $("#policy-mode") && ($("#policy-mode").onchange = () => {
    const mode = $("#policy-mode").value;
    const card = $("#policy-mode").closest(".card");
    let panel = $("#policy-allowlist");
    if (mode === "allowlist" && !panel) {
      panel = document.createElement("div");
      panel.id = "policy-allowlist";
      panel.style.marginTop = "10px";
      panel.innerHTML = '<input id="policy-models" placeholder="模型标识，多个用逗号分隔">';
      card.insertBefore(panel, $("#save-policy").parentElement.nextSibling);
    } else if (mode !== "allowlist" && panel) {
      panel.remove();
    }
  });
  $("#save-model") && ($("#save-model").onclick = async () => {
    // 下拉没得选时（授权目录为空），手输框是唯一入口，两个一起读。
    const picked = $("#my-model").value;
    const typed = ($("#my-model-text") ? $("#my-model-text").value : "").trim();
    const model = picked || typed;
    try { await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/model-policy/model", "PUT", { model }); await loadTeam(); render(); say(model ? "已保存" : "已改为跟随团队默认"); }
    catch (e) { say(e.message, "err"); }
  });
  $("#add-rule") && ($("#add-rule").onclick = async () => {
    const ruleName = $("#rule-name").value.trim();
    if (!ruleName) return say("先给规则起个名字", "err");
    const blocked = $("#rule-blocked").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const rate = $("#rule-rate").value;
    const body = { ruleName, ...(blocked.length ? { blockedModels: blocked } : {}), ...(rate ? { maxRequestsPerUserPerHour: Number(rate) } : {}) };
    try {
      await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/model-policy-rules", "POST", body);
      await loadTeam(); render(); say("规则已添加");
    } catch (e) { say(e.message, "err"); }
  });
  for (const b of document.querySelectorAll("[data-rule-toggle]")) b.onclick = async () => {
    const id = b.dataset.ruleToggle;
    const rule = (state.rules || []).find((r) => r.id === id);
    if (!rule) return;
    try {
      await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/model-policy-rules/" + encodeURIComponent(id) + "/enabled", "PUT", { enabled: !rule.enabled });
      await loadTeam(); render(); say(rule.enabled ? "规则已停用" : "规则已启用");
    } catch (e) { say(e.message, "err"); }
  };
  for (const b of document.querySelectorAll("[data-rule-del]")) b.onclick = async () => {
    const id = b.dataset.ruleDel;
    const rule = (state.rules || []).find((r) => r.id === id);
    if (!rule) return;
    // 不用系统 confirm 对话框：第一次点击把按钮变成「确认删除」，再点一次才真删。
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1"; b.textContent = "确认删除？"; b.classList.add("danger");
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = "0"; b.textContent = "删除"; b.classList.remove("danger"); } }, 5000);
      return;
    }
    try {
      await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/model-policy-rules/" + encodeURIComponent(id), "DELETE");
      await loadTeam(); render(); say("规则已删除");
    } catch (e) { say(e.message, "err"); }
  };
  $("#save-model-config") && ($("#save-model-config").onclick = async () => {
    const model = ($("#model-name") ? $("#model-name").value : "").trim();
    const apiKey = ($("#model-key") ? $("#model-key").value : "").trim();
    if (!model) return say("先填模型标识", "err");
    if (!apiKey) return say("先填 API Key", "err");
    try {
      await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/model-config", "PUT", { model, apiKey });
      await loadTeam(); render(); say("模型接入已保存");
    } catch (e) { say(e.message, "err"); }
  });
  $("#rotate-key") && ($("#rotate-key").onclick = async () => {
    const apiKey = ($("#model-key") ? $("#model-key").value : "").trim();
    if (!apiKey) return say("先填新的 API Key", "err");
    const model = (state.modelConfig && state.modelConfig.model) || "";
    try {
      await api("/v1/teams/" + encodeURIComponent(state.teamId) + "/model-config", "PUT", { model, apiKey });
      await loadTeam(); render(); say("Key 已更新");
    } catch (e) { say(e.message, "err"); }
  });
}

(async function start() {
  if (!state.token) { render(); return; }
  try { await loadStatus(); await loadTeam(); render(); }
  catch (e) { state.token = ""; localStorage.removeItem("team-token"); render(); }
})();
`;

/** 团队服务的 Web 界面页面。返回 html 和它的 CSP nonce。 */
export function teamWebPage(): { html: string; nonce: string } {
  const nonce = randomBytes(18).toString("base64");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大嘴助手 · 团队空间</title>
<style>${STYLES}</style>
</head>
<body>
<div id="app"><div class="wrap"><p style="color:var(--muted)">正在加载…</p></div></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  return { html, nonce };
}
