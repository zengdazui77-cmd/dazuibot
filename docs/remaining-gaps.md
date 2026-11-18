# 剩余四项的现状与处置

日期：2026-11-18

这四项之前笼统记作「未打通」，容易误解成代码没写完。逐项核实后，实际是三种不同性质：

| 项 | 性质 | 代码状态 | 为什么算「未打通」 |
|---|---|---|---|
| 跨进程撤权 | **✅ 本轮已验证** | 服务端已实现，本轮补了跨进程端到端验证 | 此前只被同进程测过 |
| 真实 DSH runner | 部分可验证 | runner 代码在，本轮修好了「测的不是跑的那份」；**真跑一次任务仍需容器** | 归档检查此前是另一份拷贝 |
| 集群隔离 | 需外部环境 | 代码在（NetworkPolicy、K8s Job），无法本地验证 | 需要真集群 |
| 生产部署 | 需外部环境 | 脚本齐备 | 需要云主机、域名、证书 |

「需要外部环境」的两项在没有 Docker/K8s 的机器上无法验证，硬做只会写出没跑过的代码。
所以本轮把精力放在**前两项**——其中一项此前只是没人真的跑过。

---

## 一、跨进程撤权 ✅ 已验证

### 已有的实现

服务端（`team-service/src/service.ts`）：

- `removeMember()`：移除成员时把该成员的 `queued`/`running` 任务标成 `cancelled`（`error_code='member_removed'`），
  同时 `cancelCodeTasksForMember()` 取消他的代码任务。
- `leaveTeam()`：同上，`error_code='member_left'`。
- `revokeSession(token)`：删掉会话行。桌面端下次调任何接口都会拿到 401。

Worker（`team-service/src/worker.ts`）：

- `isAuthorizedForCall()` 在**每次调模型之前**重新查成员关系与凭据指纹。
  成员已被移除 → 不再是 owner/admin/developer → 任务判失败（`member_or_key_revoked`）。
  这是关键：不是入队时查一次，而是取任务时查，所以撤权立即生效。

执行器（`team-service/executor/src/executor.ts`）：

- 心跳拿回 `shouldStop` 时立刻删掉 K8s Job、Secret 和 NetworkPolicy。

### 本轮补上的验证

`scripts/local-pilot.ts`（`npm run pilot:local`）现在起**第二个独立客户端**——
自己的 dataDir、自己的加密会话文件、真的 `TeamClient`——用它来撤第一个客户端的权限。
覆盖四条路径：

| 路径 | 验证点 |
|---|---|
| 会话撤销 | 原会话下一次请求 401；客户端自己发现 401 后清掉本地会话文件 |
| 成员移除 | 被移除者请求被拒（404）；**其排队任务被取消**（`cancelled/member_removed`） |
| 角色降级 | 降为只读后发言被拒（403） |
| 退出团队 | 退出后不再属于任何团队 |

演练共 **40 步全部通过**，已接进 CI（`.github/workflows/team-service.yml` 的 `local-pilot` 作业）。

其中「排队任务被取消」这一条是关键：撤权不能只是界面上看不到，
模型 Key 照样会被用掉。

### 顺带修掉的演练脚本本身的问题

- `ROOT` 用 `URL.pathname` 算，中文路径会被百分号编码 → 改用 `fileURLToPath`
- 动态 `import()` 在 Windows 上必须是 `file://` URL
- 假模型网关只认 `/chat/completions`，而 Worker 打的是 `{base}/chat/completions`（base 已含 `/v1`）→ 404
- 手写的 PGlite 适配器把 `rowCount` 固定成 `rows.length`，DELETE 会误报 0 → 改用团队服务自己的 `PGlitePool`

---

## 二、真实 DSH runner（部分）

### 本轮修掉的问题：测的不是跑的那份

`run-task.mjs`（runner 镜像入口）此前**自己另写了一份**归档安全检查，
而单测覆盖的是 `src/archive.ts` 里那份。两份逻辑一旦分叉，
被测过的就不是真正跑着的那份——归档检查挡的是符号链接、设备文件和路径穿越，
这是 runner 的关键安全边界。

现在：

- `executor/archive.mjs` 由 `src/archive.ts` 经 TypeScript 编译器转译生成（`executor/build-archive.mjs`）
- `run-task.mjs` 直接 `import { validateTarListing, validateTarVerboseListing } from './archive.mjs'`
- `executor/test/runner.test.ts` 钉住这一点：
  - runner 必须 import archive.mjs，且内联的旧检查必须已经不在
  - 生成的 archive.mjs 与 TS 源**对同样的输入给出同样的判断**（6 组清单 + 3 组类型）
  - Dockerfile 带上 archive.mjs，且构建时 `node --check` 过
- CI 会重新生成 archive.mjs 并 `git diff --exit-code`，防止改了 TS 源却忘了重新生成

（顺带：`extractRepositoryArchive` 此前是导出但没人用的死代码；现在 runner 与它共用同一套检查。）

### 仍未验证的部分

真跑一次 DSH 任务需要：能连的模型网关 + 可用的 K8s 集群
（Job 规格里写死了 `/workspace`、`/opt/dazuibot/dsh-runtime` 这些容器内路径）。
这部分**本轮仍未验证**，原因和「集群隔离」相同——需要容器环境。

---

## 三、集群隔离（需外部环境）

代码在，但**一行都没在真集群上跑过**：

- `team-service/executor/src/kubernetes.ts`：建 Job、Secret、NetworkPolicy；心跳序列、幂等、清理
- `team-service/executor/deploy/kubernetes.yaml`：NetworkPolicy 逐任务限制入站（全部拒绝）、
  出站只允许团队 API 与集群 DNS
- 控制器与 API 分属不同 namespace（`dazuibot-tasks` / `dazuibot-team`）

验证它需要：

1. 一台能跑 K8s 的机器（本地 minikube/kind 也行）
2. 按 digest 固定的两个镜像（`Dockerfile` 与 `Dockerfile.control`）
3. 团队 API 与 PostgreSQL 先在集群里跑起来（当前 API 只有 Docker Compose 部署方式，
   `deploy/kubernetes.yaml` 明确说明它**不**部署 API 和数据库）
4. NetworkPolicy 真的被集群强制执行（不是只看 YAML 解析通过）

**本机没有可用的 Docker 守护进程**（此前尝试过：WSL 里的 docker-desktop 停着，
且即使起来，Windows 上的 Docker 也跑不了这里的 Linux 镜像）。
所以这一项本轮**没有进展**，也不打算用「解析 YAML 通过」冒充验证。

## 四、生产部署（需外部环境）

脚本齐备（`team-service/scripts/`：初始化环境、备份、恢复、Nginx 配置检查、打包），
但没有真跑过。需要：云主机、域名 DNS、SMTP 账号、签名证书、Linux 权限、HTTPS/Nginx、
真实 PostgreSQL、异地备份恢复演练。

**本轮同样没有进展。**

---

## 仍未打通的（诚实清单）

1. **集群里的 NetworkPolicy 强制执行** —— 需要 K8s
2. **真 DSH 跑完一个真实代码任务** —— 需要能连模型网关 + 容器/K8s
3. **生产环境部署演练** —— 需要云主机与域名
4. **策略缓存与预设模板** —— 上一轮已说明：缓存必须绑定策略变更事件主动失效（否则撤权有 5 分钟延迟，不可接受）；
   预设模板要重新设计成不绑定具体模型名的版本

前 3 项是环境问题，不是代码问题；第 4 项是设计取舍，已写进 `MERGE-NOTES.md`。

