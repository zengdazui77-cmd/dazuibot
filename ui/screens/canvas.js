// 无限画布：一张可以放节点、连线的白板。
//
// 节点三种：文字、图片、形状。图片从本机选文件后放进来（存进浏览器 IndexedDB 不现实，
// 这里存 dataURL，体积小的图才合适）。
//
// 平移缩放：空白处拖动平移，滚轮缩放（按住 Ctrl 时只缩放，不平移）。
// 连线：从节点右侧的圆点拖到另一个节点，连上后线上出现箭头。
//
// 数据存在 localStorage（键 amb-canvas），跟界面偏好一样只在本机。
// 导出把当前画布写成 JSON 文件下载，方便备份或分享。
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html, Button, Icon, IconButton, Notice, Spinner } from "../components/ui.js";
import { failed, toast } from "../lib/store.js";
import { api } from "../lib/api.js";
import { t } from "../lib/i18n.js";

const KEY = "amb-canvas";
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const NODE_W = 180;
const NODE_H = 84;

let seq = 0;
const nextId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 节点：{ id, kind: "text"|"image"|"shape", x, y, w, h, text, color, src } */
function newNode(kind, x, y) {
  const base = { id: nextId(), kind, x: Math.round(x), y: Math.round(y), w: NODE_W, h: NODE_H, text: "", color: "", src: "" };
  if (kind === "text") base.text = t("canvas.nodeDefaultText");
  if (kind === "shape") base.color = "brand";
  return base;
}

function loadCanvas() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && Array.isArray(raw.nodes) && Array.isArray(raw.edges)) {
      return {
        nodes: raw.nodes.filter((n) => n && typeof n.id === "string" && Number.isFinite(n.x) && Number.isFinite(n.y)),
        edges: raw.edges.filter((e) => e && typeof e.from === "string" && typeof e.to === "string"),
        view: raw.view && Number.isFinite(raw.view.x) && Number.isFinite(raw.view.k) ? raw.view : { x: 0, y: 0, k: 1 },
      };
    }
  } catch {
    /* 存坏了就当空的 */
  }
  return { nodes: [], edges: [], view: { x: 0, y: 0, k: 1 } };
}

function saveCanvas(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 存不下（图太大）就不存，下次打开还是内存里的
  }
}

/** 节点连线的起点终点：文字/图片取右侧中点，形状取上下左右里离中心最近的一侧 */
function anchor(node, toward) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  if (!toward) return { x: node.x + node.w, y: cy };
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) > Math.abs(dy)) return { x: dx >= 0 ? node.x + node.w : node.x, y: cy };
  return { x: cx, y: dy >= 0 ? node.y + node.h : node.y };
}

export function CanvasScreen({ onBack }) {
  const [state, setState] = useState(loadCanvas);
  const [selected, setSelected] = useState("");
  const [tool, setTool] = useState("select");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(null); // { kind: "pan"|"node"|"link", ... }
  const [genPrompt, setGenPrompt] = useState("");
  const [genModel, setGenModel] = useState("");
  const [genModels, setGenModels] = useState([]);
  const [generating, setGenerating] = useState(false);
  const stageRef = useRef(null);
  const imageRef = useRef(null);
  const jsonRef = useRef(null);

  const { nodes, edges, view } = state;

  // 改动后存一次
  useEffect(() => { saveCanvas(state); }, [state]);

  const mutate = useCallback((fn) => setState((s) => ({ ...s, ...fn(s) })), []);

  const toStage = useCallback((clientX, clientY) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  }, [view]);

  // —— 滚轮缩放（以指针为中心）——
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setState((s) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.view.k * factor));
      if (k === s.view.k) return s;
      // 让指针下的那一点保持不动
      const ratio = k / s.view.k;
      return { ...s, view: { k, x: px - (px - s.view.x) * ratio, y: py - (py - s.view.y) * ratio } };
    });
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // —— 指针按下 ——
  const onStageDown = (e) => {
    if (e.button !== 0) return;
    const p = toStage(e.clientX, e.clientY);
    if (tool === "text" || tool === "shape") {
      const kind = tool === "text" ? "text" : "shape";
      const node = newNode(kind, p.x - NODE_W / 2, p.y - NODE_H / 2);
      mutate((s) => ({ ...s, nodes: [...s.nodes, node] }));
      setSelected(node.id);
      setTool("select");
      return;
    }
    // 空白处：平移画布，并清掉选中
    setSelected("");
    setDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y });
  };

  const onNodeDown = (e, node) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(node.id);
    if (tool !== "select") return;
    setDrag({ kind: "node", id: node.id, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y });
  };

  // 连线把手：从节点右侧圆点拖出
  const onHandleDown = (e, node) => {
    e.stopPropagation();
    const p = toStage(e.clientX, e.clientY);
    setDrag({ kind: "link", from: node.id, x: p.x, y: p.y });
  };

  // —— 指针移动 ——
  const onPointerMove = (e) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      setState((s) => ({ ...s, view: { ...s.view, x: drag.ox + (e.clientX - drag.sx), y: drag.oy + (e.clientY - drag.sy) } }));
      return;
    }
    if (drag.kind === "node") {
      const k = view.k;
      const nx = drag.ox + (e.clientX - drag.sx) / k;
      const ny = drag.oy + (e.clientY - drag.sy) / k;
      mutate((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === drag.id ? { ...n, x: Math.round(nx), y: Math.round(ny) } : n)) }));
      return;
    }
    if (drag.kind === "link") {
      const p = toStage(e.clientX, e.clientY);
      setDrag({ ...drag, x: p.x, y: p.y });
    }
  };

  const onPointerUp = () => {
    if (drag && drag.kind === "link" && drag.to) {
      mutate((s) => (s.edges.some((e) => e.from === drag.from && e.to === drag.to)
        ? s
        : { ...s, edges: [...s.edges, { id: nextId(), from: drag.from, to: drag.to }] }));
    }
    setDrag(null);
  };

  // 指针落在哪个节点上（连线用）
  const nodeAt = (x, y) => nodes.find((n) => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h);

  // —— 键盘：删除选中节点 ——
  useEffect(() => {
    const onKey = (e) => {
      if (!selected) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        mutate((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== selected), edges: s.edges.filter((ed) => ed.from !== selected && ed.to !== selected) }));
        setSelected("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  // —— 图片节点：选文件 ——
  const pickImage = () => imageRef.current?.click();

  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError(t("canvas.notImage")); return; }
    setError("");
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      setBusy(false);
      const img = new Image();
      img.onload = () => {
        const p = toStage(0, 0);
        const scale = Math.min(1, 240 / (img.width || 1));
        const node = newNode("image", p.x - (img.width * scale) / 2, p.y - (img.height * scale) / 2);
        node.w = Math.max(80, Math.round((img.width || 240) * scale));
        node.h = Math.max(60, Math.round((img.height || 160) * scale));
        node.src = String(reader.result || "");
        mutate((s) => ({ ...s, nodes: [...s.nodes, node] }));
        setSelected(node.id);
      };
      img.onerror = () => { setBusy(false); setError(t("canvas.imageReadFailed")); };
      img.src = String(reader.result || "");
    };
    reader.onerror = () => { setBusy(false); setError(t("canvas.imageReadFailed")); };
    reader.readAsDataURL(file);
  };

  // —— AI 生图 ——
  // 可用的图片模型从服务端取一次（/media/models）；没有连上站点时这里就是空的，
  // 生成按钮会直接说清楚原因，而不是让用户等一个看不懂的报错。
  useEffect(() => {
    let alive = true;
    api("/media/models").then((d) => {
      if (!alive) return;
      const list = Array.isArray(d?.image) ? d.image : [];
      setGenModels(list);
      if (!genModel && list.length) setGenModel(d?.recommended?.image || list[0]);
    }).catch(() => { if (alive) setGenModels([]); });
    return () => { alive = false; };
  }, []);

  const generateImage = async () => {
    const prompt = genPrompt.trim();
    if (!prompt) { setError(t("canvas.genPromptMissing")); return; }
    setError("");
    setGenerating(true);
    try {
      const res = await fetch("/amb/api/media/image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, ...(genModel ? { model: genModel } : {}) }),
      });
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json())?.error || ""; } catch { /* 不是 JSON 就用状态码 */ }
        throw new Error(detail || t("canvas.genFailed", { code: res.status }));
      }
      const blob = await res.blob();
      const src = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(t("canvas.imageReadFailed")));
        reader.readAsDataURL(blob);
      });
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error(t("canvas.imageReadFailed")));
        el.src = src;
      });
      const p = toStage(0, 0);
      const scale = Math.min(1, 240 / (img.width || 1));
      const node = newNode("image", p.x - (img.width * scale) / 2, p.y - (img.height * scale) / 2);
      node.w = Math.max(80, Math.round((img.width || 240) * scale));
      node.h = Math.max(60, Math.round((img.height || 160) * scale));
      node.src = src;
      node.text = prompt;
      mutate((s) => ({ ...s, nodes: [...s.nodes, node] }));
      setSelected(node.id);
      setGenPrompt("");
      toast(t("canvas.genDone"));
    } catch (e) {
      setError(e.message || t("canvas.genFailed", { code: "" }));
    } finally {
      setGenerating(false);
    }
  };

  // —— 导出 / 导入 / 清空 ——
  const exportCanvas = () => {
    const data = JSON.stringify({ version: 1, nodes, edges }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `canvas-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(t("canvas.exported"));
  };

  const importCanvas = () => jsonRef.current?.click();

  const onImport = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || ""));
        if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error("bad");
        setState({ nodes: data.nodes, edges: data.edges, view: { x: 0, y: 0, k: 1 } });
        setSelected("");
        toast(t("canvas.imported"));
      } catch {
        setError(t("canvas.importFailed"));
      }
    };
    reader.readAsText(file);
  };

  const clearCanvas = () => {
    if (!nodes.length && !edges.length) return;
    if (!window.confirm(t("canvas.clearConfirm"))) return;
    setState((s) => ({ ...s, nodes: [], edges: [] }));
    setSelected("");
  };

  const zoomTo = (k) => setState((s) => ({ ...s, view: { ...s.view, k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k)) } }));

  const selectedNode = nodes.find((n) => n.id === selected);

  const lines = useMemo(() => edges.map((e) => {
    const a = nodes.find((n) => n.id === e.from);
    const b = nodes.find((n) => n.id === e.to);
    if (!a || !b) return null;
    const p1 = anchor(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const p2 = anchor(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
    return { id: e.id, p1, p2 };
  }).filter(Boolean), [edges, nodes]);

  return html`<main class="canvas-page" data-screen="canvas">
    <header class="canvas-bar">
      <button type="button" class="text" onClick=${onBack}>${t("canvas.back")}</button>
      <div class="canvas-tools" role="toolbar" aria-label=${t("canvas.tools")}>
        <${IconButton} icon=${tool === "select" ? "panel" : "sliders"} label=${t("canvas.toolSelect")} on=${tool === "select"} onClick=${() => setTool("select")} />
        <${IconButton} icon="compose" label=${t("canvas.toolText")} on=${tool === "text"} onClick=${() => setTool("text")} />
        <${IconButton} icon="palette" label=${t("canvas.toolShape")} on=${tool === "shape"} onClick=${() => setTool("shape")} />
        <${IconButton} icon="file" label=${t("canvas.toolImage")} onClick=${pickImage} />
        <span class="canvas-sep" role="separator" />
        <${IconButton} icon="ext" label=${t("canvas.export")} onClick=${exportCanvas} />
        <${IconButton} icon="paste" label=${t("canvas.import")} onClick=${importCanvas} />
        <${IconButton} icon="trash" label=${t("canvas.clear")} onClick=${clearCanvas} />
      </div>
      <div class="canvas-zoom">
        <${IconButton} icon="refresh" label=${t("canvas.zoomOut")} onClick=${() => zoomTo(view.k / 1.2)} />
        <button type="button" class="canvas-zoom-label" onClick=${() => zoomTo(1)} title=${t("canvas.zoomReset")}>${Math.round(view.k * 100)}%</button>
        <${IconButton} icon="plus" label=${t("canvas.zoomIn")} onClick=${() => zoomTo(view.k * 1.2)} />
      </div>
    </header>
    ${error && html`<${Notice} tone="red">${error}<//>`}
    <div class="canvas-gen">
      <input class="field" id="canvas-gen-prompt" value=${genPrompt}
        placeholder=${t("canvas.genPromptPlaceholder")}
        onInput=${(e) => setGenPrompt(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter" && !generating) generateImage(); }} />
      ${genModels.length > 1
        ? html`<select class="field" id="canvas-gen-model" value=${genModel} onChange=${(e) => setGenModel(e.target.value)}>
            ${genModels.map((m) => html`<option value=${m} key=${m}>${m}</option>`)}
          </select>`
        : genModels.length === 1 ? html`<span class="pill">${genModels[0]}</span>` : null}
      <button type="button" class="btn primary" disabled=${generating || !genPrompt.trim()} onClick=${generateImage}>
        ${generating ? html`<${Spinner} /> ${t("canvas.generating")}` : t("canvas.generate")}
      </button>
    </div>
    <div class="canvas-stage" ref=${stageRef}
      onMouseDown=${onStageDown} onMouseMove=${onPointerMove} onMouseUp=${onPointerUp} onMouseLeave=${onPointerUp}>
      <div class="canvas-world" style=${{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg class="canvas-links">
          ${lines.map((l) => html`<g key=${l.id}>
            <line x1=${l.p1.x} y1=${l.p1.y} x2=${l.p2.x} y2=${l.p2.y} />
            <circle cx=${l.p2.x} cy=${l.p2.y} r="3" />
          </g>`)}
          ${drag?.kind === "link" && (() => {
            const a = nodes.find((n) => n.id === drag.from);
            if (!a) return null;
            const p1 = anchor(a);
            return html`<g class="canvas-link-live"><line x1=${p1.x} y1=${p1.y} x2=${drag.x} y2=${drag.y} /></g>`;
          })()}
        </svg>
        ${nodes.map((n) => html`<div key=${n.id}
          class=${`canvas-node canvas-node-${n.kind}${selected === n.id ? " sel" : ""}`}
          style=${{ left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, minHeight: `${n.h}px` }}
          onMouseDown=${(e) => onNodeDown(e, n)}
          onMouseUp=${(e) => { if (drag?.kind === "link") { const hit = nodeAt(...Object.values(toStage(e.clientX, e.clientY))); setDrag((d) => (d ? { ...d, to: hit?.id || "" } : d)); } }}>
          ${n.kind === "image" && n.src
            ? html`<img src=${n.src} alt=${n.text || ""} draggable="false" />`
            : n.kind === "shape"
              ? html`<div class="canvas-shape"></div>`
              : html`<div class="canvas-text">${n.text}</div>`}
          <button type="button" class="canvas-handle" aria-label=${t("canvas.connect")}
            onMouseDown=${(e) => onHandleDown(e, n)} />
        </div>`)}
      </div>
      ${!nodes.length && html`<div class="canvas-empty">
        <p>${t("canvas.empty")}</p>
        <p class="hint">${t("canvas.emptyHint")}</p>
      </div>`}
      ${busy && html`<div class="canvas-busy"><${Spinner} /> ${t("canvas.loading")}</div>`}
    </div>
    ${selectedNode && html`<div class="canvas-inspector">
      <label class="k" for="canvas-node-text">${t("canvas.nodeText")}</label>
      <input class="field" id="canvas-node-text" value=${selectedNode.text}
        onInput=${(e) => mutate((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === selectedNode.id ? { ...n, text: e.target.value } : n)) }))} />
      <button type="button" class="text danger" onClick=${() => { mutate((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== selectedNode.id), edges: s.edges.filter((ed) => ed.from !== selectedNode.id && ed.to !== selectedNode.id) })); setSelected(""); }}>
        ${t("canvas.deleteNode")}
      </button>
    </div>`}
    <input type="file" accept="image/*" ref=${imageRef} onChange=${onFile} hidden />
    <input type="file" accept="application/json,.json" ref=${jsonRef} onChange=${onImport} hidden />
  </main>`;
}
