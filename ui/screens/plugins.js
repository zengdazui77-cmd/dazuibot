// 设置 › 插件：用户自己挑选安装的 MCP 服务器（精选目录 + 自定义），全局一份，所有机器人共用（src/agent/plugins.ts）。
// 密钥不会回到界面：接口只说哪些填了。装好后实际连一次，行里显示连上了几个工具或出错原因。
import { useEffect, useState } from "preact/hooks";
import { html, MenuButton, Seg, Sheet, Spinner, Switch } from "../components/ui.js";
import { api } from "../lib/api.js";
import { confirmSheet, failed, saved, toast } from "../lib/store.js";
import { getLang, t } from "../lib/i18n.js";

/** 目录里的说明是后端给的双语文本 */
const say = (text) => (text ? (getLang() === "zh-CN" ? text.zh : text.en) : "");

export function usePlugins() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState({});
  const [sheet, setSheet] = useState(null);
  useEffect(() => {
    api("/plugins").then(setState).catch(failed);
  }, []);
  /** 实际连一次（本机插件第一次要下载，可能要一两分钟） */
  const test = async (id) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await api(`/plugins/${encodeURIComponent(id)}/test`, { method: "POST" });
      setState(r);
      if (r.result.ok) toast(t("settings.plugins.testOk", { count: r.result.tools.length }));
      else failed(t("settings.plugins.testFailed", { error: r.result.error || "" }));
    } catch (e) {
      failed(e);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };
  return { state, setState, busy, sheet, setSheet, test };
}

/** 设置页的行：说明、已安装的、目录里还没装的 */
export function pluginRows(plug) {
  const { state, setState, busy, setSheet, test } = plug;
  if (!state) return [];
  const tab = "plugins";
  const call = async (path, opts, after) => {
    try {
      const r = await api(path, opts);
      setState(r);
      saved();
      after?.(r);
    } catch (e) {
      failed(e);
    }
  };
  const install = (c) => (c.secrets?.length ? setSheet({ kind: "secrets", item: c }) : call("/plugins", { method: "POST", body: { id: c.id } }, (r) => test(r.plugin.id)));
  const remove = async (p) => {
    if (!(await confirmSheet({ title: t("settings.plugins.removeTitle", { name: p.name }), body: t("settings.plugins.removeBody"), confirmLabel: t("settings.plugins.remove"), danger: true }))) return;
    call(`/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" });
  };
  const kind = (transport) => t(transport === "stdio" ? "settings.plugins.local" : "settings.plugins.remote");
  const rows = [
    {
      tab,
      id: "plugins-about",
      name: t("settings.plugins.about"),
      sub: t("settings.plugins.aboutSub"),
      keys: t("settings.plugins.keys"),
      ctl: html`<button type="button" class="btn" onClick=${() => setSheet({ kind: "custom" })}>${t("settings.plugins.addCustom")}</button>`,
    },
  ];
  if (!state.node) {
    rows.push({
      tab,
      id: "plugins-node",
      name: t("settings.plugins.nodeMissing"),
      sub: t("settings.plugins.nodeMissingSub"),
      ctl: html`<a class="text" href="https://nodejs.org" target="_blank" rel="noopener noreferrer">nodejs.org ↗</a>`,
    });
  }
  for (const p of state.installed) {
    const c = state.catalog.find((x) => x.id === p.catalogId);
    const status = p.needsSetup
      ? t("settings.plugins.needsSetup")
      : busy[p.id]
        ? t("settings.plugins.testing")
        : !p.lastTest
          ? t("settings.plugins.untested")
          : p.lastTest.ok
            ? t("settings.plugins.connected", { count: p.lastTest.tools.length })
            : t("settings.plugins.failedWith", { error: p.lastTest.error || "" });
    rows.push({
      tab,
      id: `plugin-${p.id}`,
      name: p.name,
      sub: [kind(p.transport), p.target, status].filter(Boolean).join(" · "),
      keys: `${p.name} ${t("settings.plugins.keys")}`,
      ctl: html`<${Switch} label=${t("settings.plugins.enabled", { name: p.name })} value=${p.enabled}
          onChange=${(v) => call(`/plugins/${encodeURIComponent(p.id)}`, { method: "PUT", body: { enabled: v } })} />
        <${MenuButton} label=${t("settings.plugins.approval")} value=${p.approval} width=${280}
          options=${[["ask", t("settings.plugins.ask"), t("settings.plugins.askNote")], ["auto", t("settings.plugins.auto"), t("settings.plugins.autoNote")]]}
          onChange=${(v) => call(`/plugins/${encodeURIComponent(p.id)}`, { method: "PUT", body: { approval: v } })} />
        <button type="button" class="text" disabled=${!!busy[p.id] || p.needsSetup} onClick=${() => test(p.id)}>${busy[p.id] ? html`<${Spinner} />` : t("settings.plugins.test")}</button>
        ${c?.secrets?.length ? html`<button type="button" class="text" onClick=${() => setSheet({ kind: "secrets", item: c, installed: p })}>${t("settings.plugins.configure")}</button>` : null}
        <button type="button" class="text danger" onClick=${() => remove(p)}>${t("settings.plugins.remove")}</button>`,
    });
  }
  for (const c of state.catalog.filter((x) => !state.installed.some((p) => p.catalogId === x.id))) {
    rows.push({
      tab,
      id: `plugin-catalog-${c.id}`,
      name: c.name,
      sub: [say(c.desc), c.maintainer, kind(c.transport)].filter(Boolean).join(" · "),
      keys: `${c.name} ${c.maintainer} ${c.category} ${t("settings.plugins.keys")}`,
      ctl: html`<a class="text" href=${c.homepage} target="_blank" rel="noopener noreferrer">${t("settings.plugins.homepage")}</a>
        <button type="button" class="btn primary" onClick=${() => install(c)}>${t("settings.plugins.install")}</button>`,
    });
  }
  return rows;
}

/** 安装或重新配置目录里的插件：填它要的 Key */
function SecretSheet({ plug, item, installed, onClose }) {
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const fields = item.secrets || [];
  const filled = (f) => !!(values[f.key] || "").trim() || (installed && installed.secretsSet.includes(f.key));
  const ready = fields.every((f) => f.optional || filled(f));
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    // 没填的不发：重新配置时留空 = 不改
    const secrets = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    try {
      const r = installed
        ? await api(`/plugins/${encodeURIComponent(installed.id)}`, { method: "PUT", body: { secrets } })
        : await api("/plugins", { method: "POST", body: { id: item.id, secrets } });
      plug.setState(r);
      saved();
      onClose();
      plug.test(r.plugin.id);
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Sheet} title=${t(installed ? "settings.plugins.configureTitle" : "settings.plugins.installTitle", { name: item.name })} onClose=${onClose}>
    <form onSubmit=${submit}>
      <p class="hint">${say(item.desc)}</p>
      <p class="hint">${t(item.transport === "stdio" ? "settings.plugins.localWarn" : "settings.plugins.remoteWarn")}</p>
      ${fields.map((f) => html`<label class="set-field" key=${f.key}>
        <span class="k">${say(f.label)}${f.url && html`<a class="text" href=${f.url} target="_blank" rel="noopener noreferrer">${t("settings.plugins.getKey")}</a>`}</span>
        <input class="field" type="password" autocomplete="new-password" maxlength="4096" value=${values[f.key] || ""}
          placeholder=${installed && installed.secretsSet.includes(f.key) ? t("settings.plugins.keepHint") : ""}
          onInput=${(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
      </label>`)}
      <p class="hint">${t("settings.plugins.secretHint")}</p>
      <div class="actions"><button type="submit" class="btn primary" disabled=${busy || !ready}>${t(installed ? "settings.plugins.save" : "settings.plugins.install")}</button></div>
    </form>
  <//>`;
}

/** 一行命令拆成可执行文件和参数：空白分隔，带空格的参数用双引号包起来 */
const tokens = (line) => (line.match(/"[^"]*"|\S+/g) || []).map((x) => x.replace(/^"|"$/g, ""));

/** 自定义插件：远程地址，或在本机运行的命令 */
function CustomSheet({ plug, onClose }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("http");
  const [url, setUrl] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [command, setCommand] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = name.trim() && (transport === "http" ? url.trim() : command.trim());
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    let custom;
    if (transport === "http") custom = { name, transport, url, authorization };
    else {
      const [cmd, ...args] = tokens(command);
      const env = {};
      for (const line of envText.split("\n").map((x) => x.trim()).filter(Boolean)) {
        const i = line.indexOf("=");
        if (i < 1) return failed(t("settings.plugins.envBad", { line: line.slice(0, 40) }));
        env[line.slice(0, i).trim()] = line.slice(i + 1);
      }
      custom = { name, transport, command: cmd || "", args, env };
    }
    setBusy(true);
    try {
      const r = await api("/plugins", { method: "POST", body: { custom } });
      plug.setState(r);
      saved();
      onClose();
      plug.test(r.plugin.id);
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Sheet} title=${t("settings.plugins.customTitle")} onClose=${onClose}>
    <form onSubmit=${submit}>
      <p class="hint">${t("settings.plugins.customHint")}</p>
      <label class="set-field"><span class="k">${t("settings.plugins.name")}</span><input class="field" maxlength="40" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
      <div class="set-field"><${Seg} label=${t("settings.plugins.kind")} value=${transport} onChange=${setTransport}
        options=${[["http", t("settings.plugins.remote")], ["stdio", t("settings.plugins.local")]]} /></div>
      ${transport === "http"
        ? html`<label class="set-field"><span class="k">${t("settings.plugins.url")}</span><input class="field" type="url" placeholder="https://example.com/mcp" maxlength="2000" value=${url} onInput=${(e) => setUrl(e.target.value)} /></label>
            <label class="set-field"><span class="k">${t("settings.plugins.authorization")}</span><input class="field" type="password" autocomplete="new-password" placeholder="Bearer …" maxlength="4096" value=${authorization} onInput=${(e) => setAuthorization(e.target.value)} /></label>
            <p class="hint">${t("settings.plugins.remoteWarn")}</p>`
        : html`<label class="set-field"><span class="k">${t("settings.plugins.command")}</span><input class="field mono" placeholder="npx -y some-mcp-server" maxlength="2000" value=${command} onInput=${(e) => setCommand(e.target.value)} /></label>
            <label class="set-field"><span class="k">${t("settings.plugins.env")}</span><textarea class="field mono" rows="3" placeholder="API_KEY=…" value=${envText} onInput=${(e) => setEnvText(e.target.value)}></textarea></label>
            <p class="hint">${t("settings.plugins.localWarn")}</p>`}
      <p class="hint">${t("settings.plugins.secretHint")}</p>
      <div class="actions"><button type="submit" class="btn primary" disabled=${busy || !ready}>${t("settings.plugins.add")}</button></div>
    </form>
  <//>`;
}

export function PluginSheets({ plug }) {
  const { sheet, setSheet } = plug;
  if (!sheet) return null;
  const close = () => setSheet(null);
  if (sheet.kind === "custom") return html`<${CustomSheet} plug=${plug} onClose=${close} />`;
  return html`<${SecretSheet} key=${sheet.item.id} plug=${plug} item=${sheet.item} installed=${sheet.installed} onClose=${close} />`;
}
