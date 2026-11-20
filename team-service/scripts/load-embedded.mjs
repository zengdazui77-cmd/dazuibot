/**
 * 加载内嵌团队服务（`src/embedded.ts`）的辅助函数。
 *
 * 为什么需要它：这个文件里的脚本会被两种方式跑 ——
 *   - `tsx scripts/xxx.mjs`（开发时，package.json 里的 npm 脚本就是这种）
 *   - `node scripts/xxx.mjs`（部署包里只给 node 用；打包脚本会把 dist/ 排除掉，
 *     所以部署机上根本没有编译产物）
 *
 * 源码是 TypeScript，编译产物在 dist/。三种情况都要能起来：
 *   1. 有 dist/embedded.js  —— 直接 import 它（部署机上 npm run build 过的情况）
 *   2. 只有 src/embedded.ts —— 用 tsx 的编程接口在运行时加载它
 *   3. tsx 已经在跑 —— import 里的 .js 会被映射回 .ts，直接 import 即可
 *
 * 之前脚本里写死 `import("../src/embedded.js")`：在 tsx 下能跑，
 * 但用 node 直接跑时会以 ERR_MODULE_NOT_FOUND 崩掉 —— 而脚本注释里写的用法正是 node。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(here, "..", "dist", "embedded.js");
const srcPath = path.join(here, "..", "src", "embedded.ts");

/**
 * 加载 startEmbeddedTeamService。
 * @returns {Promise<{ startEmbeddedTeamService: Function }>}
 */
export async function loadEmbedded() {
  if (fs.existsSync(distPath)) {
    return await import("../dist/embedded.js");
  }
  if (!fs.existsSync(srcPath)) {
    throw new Error(
      "找不到团队服务代码：既没有 dist/embedded.js（跑 npm run build 生成），也没有 src/embedded.ts。"
    );
  }
  // tsx 的编程接口：不用起子进程，就能在当前进程里加载 .ts。
  // tsx 本身是 devDependency：部署机上如果用的是 `npm ci --omit=dev`，
  // 那就没有它 —— 但那种情况下 dist/ 应该是构建好的（见上面第一条）。
  try {
    const { tsImport } = await import("tsx/esm/api");
    return await tsImport("../src/embedded.ts", import.meta.url);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "";
    if (err && err.code === "ERR_MODULE_NOT_FOUND" && msg.includes("tsx")) {
      // tsx 不在：当前进程本身可能就是 tsx 起的（tsx 会注册解析钩子，
      // import 里的 .js 会被映射回 .ts）。那就直接试一次。
      try {
        return await import("../src/embedded.js");
      } catch (inner) {
        throw new Error(
          "加载团队服务源码失败：既没有编译产物 dist/embedded.js，" +
          "运行这些脚本又需要 tsx。请先 `npm ci`（装上 devDependencies）并 `npm run build`。" +
          `原始错误：${inner && inner.message ? inner.message : String(inner)}`
        );
      }
    }
    throw err;
  }
}
