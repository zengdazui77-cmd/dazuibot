// findAppRoot 的回归测试：它曾经拿 package.json 的 name 当路径锚点，改名后静默退化成
// process.cwd()，开发期和测试全绿、打包后才炸（ui 静态资源根、DSH 运行时、magpie 二进制一起找错）。
// 这里钉死的是「认目录结构、不认产品名」。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAppRoot } from "../src/magpie/supervisor.js";

const dirs: string[] = [];

function makeRoot(name: string, withUi = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-root-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, main: "dist/electron/main.js", version: "9.9.9" }),
  );
  if (withUi) {
    fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ui", "index.html"), "<!doctype html>");
  }
  fs.mkdirSync(path.join(dir, "dist", "magpie"), { recursive: true });
  return dir;
}

const real = (p: string) => fs.realpathSync(p);

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("findAppRoot", () => {
  it("从深层目录往上能找到应用根", () => {
    const root = makeRoot("dazuibot");
    expect(real(findAppRoot(path.join(root, "dist", "magpie")))).toBe(real(root));
  });

  it("产品名换成别的照样能找到——不拿 name 当锚点", () => {
    // 这条就是当初炸掉的那条：name 从 anymodel-bot 改成 dazuibot 后六层循环全落空。
    for (const name of ["anymodel-bot", "dazuibot", "whatever-else", "随便什么名字"]) {
      const root = makeRoot(name);
      expect(real(findAppRoot(path.join(root, "dist", "magpie")))).toBe(real(root));
    }
  });

  it("有 package.json 但没有 ui/index.html 的目录不算应用根", () => {
    const root = makeRoot("dazuibot", false);
    // 找不到特征就退化成 cwd，绝不能是这个临时目录
    expect(real(findAppRoot(path.join(root, "dist", "magpie")))).not.toBe(real(root));
  });

  it("package.json 没有 main 入口也不算应用根", () => {
    const root = makeRoot("dazuibot");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dazuibot" }));
    expect(real(findAppRoot(path.join(root, "dist", "magpie")))).not.toBe(real(root));
  });

  it("找不到时退回 cwd，不抛错", () => {
    const deep = fs.mkdtempSync(path.join(os.tmpdir(), "no-root-"));
    dirs.push(deep);
    fs.mkdirSync(path.join(deep, "a", "b", "c", "d", "e", "f", "g"), { recursive: true });
    expect(() => findAppRoot(path.join(deep, "a", "b", "c", "d", "e", "f", "g"))).not.toThrow();
    expect(findAppRoot(path.join(deep, "a", "b", "c", "d", "e", "f", "g"))).toBe(process.cwd());
  });

  it("真实的仓库根能被找到（兜底检查，防止改坏了自己都不知道）", () => {
    expect(fs.existsSync(path.join(findAppRoot(), "ui", "index.html"))).toBe(true);
  });
});
