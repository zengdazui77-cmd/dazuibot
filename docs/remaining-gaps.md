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

## 三、集群隔离（✅ 本轮已验证）

代码在，**本轮在这台机器上真跑起来了**。

### 本机环境（2026-11-19 实测）

这台机器是联想云桌面（型号 83JJ），本来跑不了容器。实测下来可以，办法是：

1. 装一个真正的 Linux 发行版到 WSL2：`wsl --install -d Ubuntu-24.04 --no-launch`
   （原来只有 docker-desktop 那个「瘦壳」发行版，里面没有 dockerd）
2. 里面装 `docker.io` + `uidmap`，用 systemd 托管 dockerd
3. K8s 用 **k3s**（单二进制，自带 flannel），不用 kind：
   - kind 的容器在这台机器上反复重启（`ExitCode=128`，kubelet 反复重启 containerd），
     而且 WSL2 的 `127.0.0.1:<port>` 转发不稳，kubectl 时连时断
   - k3s 直接跑在 WSL 里，不经 docker 网络，问题少得多

```sh
wsl --install -d Ubuntu-24.04 --no-launch
# 在 WSL 里：
curl -sfL https://github.com/k3s-io/k3s/releases/download/v1.31.5%2Bk3s1/k3s -o /usr/local/bin/k3s
k3s server --disable traefik --write-kubeconfig-mode 644
```

### NetworkPolicy 确实被强制执行（对照实验）

同一对 Pod，逐段改策略，用 wget 的退出码判定（每次先清空所有策略 ——
NetworkPolicy 的规则是叠加的，一条放行就能抵消一条 deny-all）：

| 段 | 策略 | 结果 |
|---|---|---|
| A | 无任何策略 | 退出码 0（**通**） |
| B | `deny-all-ingress`（`podSelector: {}`，`policyTypes: [Ingress]`） | 退出码 1（**被挡**） |
| C | 只放行来自 `app=client` 的 Pod | 退出码 0（**又能通**） |

三段都对得上，说明这台机器上 flannel 的策略是真的在拦流量，不是只看 YAML 解析通过。

**注意**：k3s 里 CoreDNS 有问题（`NXDOMAIN`），Pod 间**服务名**解析不了，
但用 IP 直连正常。测网络策略时要用 IP，不要用服务名。

### 仍未验证的部分

上面验证的是「集群会强制执行 NetworkPolicy」。本项目的执行器那套
（`deploy/kubernetes.yaml` 里的逐任务 NetworkPolicy、跨 namespace 的
API↔控制器通信、任务级 capability token）还需要把团队 API 和执行器
真正部署进集群再验一遍。集群本身已经就绪。

## 四、生产部署（需外部环境）

脚本齐备（`team-service/scripts/`：初始化环境、备份、恢复、Nginx 配置检查、打包），
但没有真跑过。需要：云主机、域名 DNS、SMTP 账号、签名证书、Linux 权限、HTTPS/Nginx、
真实 PostgreSQL、异地备份恢复演练。

**本轮同样没有进展。**

---

## 仍未打通的（诚实清单）

1. **执行器那套策略在真集群上的行为** —— 集群已就绪、NetworkPolicy 已验证会被强制执行，
   但还没把团队 API 与执行器真正部署进去跑一遍
2. **真 DSH 跑完一个真实代码任务** —— 需要能连的模型网关 + 容器（容器已能跑，缺的是模型网关）
3. **生产环境部署演练** —— 需要云主机与域名
4. **策略缓存与预设模板** —— 上一轮已说明：缓存必须绑定策略变更事件主动失效（否则撤权有 5 分钟延迟，不可接受）；
   预设模板要重新设计成不绑定具体模型名的版本

第 1、2 项本机已具备大部分条件（容器与集群都通了）；第 3 项需要外部资源；
第 4 项是设计取舍，已写进 `MERGE-NOTES.md`。

