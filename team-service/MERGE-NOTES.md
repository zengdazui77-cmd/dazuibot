# 两份 team-service 的合并结论

日期：2026-11-18

## 现状

- **权威副本**：`02-完整项目源码/dazuibot-master/team-service`（桌面 App 仓库内）
- **工作副本**：`C:\Users\zdz\teamsvc\team-service`（我调试时临时解压出来的）
- **部署包**：`03-团队服务部署/dazuibot-team-service-pilot-ready-r5.zip`（= 权威副本，已逐字节核对）

两份代码分叉已久，各有对方没有的东西：

| | 工作副本独有 | 权威副本独有 |
|---|---|---|
| 功能 | 完整模型策略系统（`model-policy.ts` 359 行 + `policy-cache.ts` / `policy-monitoring.ts` / `policy-templates.ts` / `011_model_policies.sql`） | 内嵌模式（`embedded.ts` + `pglite-pool.ts`）、打包脚本、真实 pg 集成测试、`012` 默认值修正迁移 |
| 文档 | `docs/` 5 份（部署、运维、生产配置、模型策略、功能清单） | — |
| 缺陷 | **两个时钟 bug 未修**：`service.ts:416` `expires_at > now()`、`worker.ts:150` `available_at <= $1` | 已修 |

## 关键判断

### 1. 两版的时钟 bug 是同一个，权威副本已修

工作副本 `test/team-service.test.ts` 里那条 `listInvitations` 失败，正是权威副本今天修掉的 bug
（`expires_at` 由应用时钟写入，却与数据库 `now()` 比较）。**这是独立证据：缺陷真实存在、跨版本都有、只有权威副本修了。**

### 2. 权威副本的 executor 更安全

`executor/src/executor.ts` 的 `accept()`：权威副本在 `createJob` 失败后会
`verifyStoredPayload()` + `safeTaskJob()` 校验已存在的 Job；工作副本只检查存在性就抛错，
丢失了 payload 校验（别人可以用同一个 job id 塞不同 payload）。
权威副本还有 12 行专属的安全断言测试。

### 3. 工作副本的策略系统确实接进了执行路径

`worker.ts` 在调用模型前 `enforcer.checkRequest()`，违规则
`fail(job, "policy_violation_*")`，并有 `team_policy_violations` / `team_model_usage_tracking` 两张表
记录违规与用量。它比权威副本的「只能管用哪个模型」多了速率限制、token 配额、按角色生效、违规记录。
**这份实现有价值，不应丢弃。**

### 4. 但工作副本自身测试有 2 处失败

- `test/model-policy-integration.test.ts`：SQL 参数类型推断错误（PGlite 解析器比真 pg 严格）
- `test/team-service.test.ts` 的 `listInvitations`：即上述时钟 bug

说明它不是「验证过可直接用」的成品。

### 5. 两套 API 路径不冲突

- 权威副本：`/v1/teams/:id/model-policy`（单数，单模式 all/catalog/allowlist + 成员自选）— 已接桌面端 UI
- 工作副本：`/v1/teams/:id/model-policies`（复数，多策略 CRUD + 批量启停 + 违规查询）

数据库表名也不同（`team_model_policies` vs `team_model_policies`）—— **注意：两者表名相同！**
权威副本的 `011_model_policy.sql` 与工作副本的 `011_model_policies.sql` 都建 `team_model_policies`，
但结构不同。迁移不能简单并列。

## 执行决定

**本轮（现在）**：以权威副本为唯一真源，工作副本归档保留策略系统实现作为下一阶段的合并素材。

**下一阶段**（单独立项）：

### ✅ 已完成（2026-11-18）

统一策略模型已落地，采用**两层结构**，而不是二选一：

| 层 | 表 | 语义 | 状态 |
|---|---|---|---|
| 基线 | `team_model_policies` | 决定「成员可以选哪些模型」：all / catalog / allowlist，成员在范围内自主选择 | 原有，未改 |
| 叠加 | `team_model_policy_rules` | 决定「选完之后还要遵守什么」：模型黑名单、速率限制、token 配额、角色范围 | **新增** |

两层是**「与」关系**：基线先筛出候选模型，叠加层再对实际调用的模型做拦截。
叠加层**只产生「拒绝」结论**，不产生「允许」——没有规则命中就放行。
多条规则之间同样是「与」关系：命中任一条即拒绝。

实现落在：
- `src/policy-rules.ts` — 判定逻辑（纯函数）+ 数据库读写
- `migrations/013_policy_rules.sql` — 三张表：规则 / 违规记录 / 用量统计
- `src/worker.ts` — 调模型前 `checkOverlayRules()`，命中则 `fail(job, "policy_violation_*")`；成功后记录用量
- `src/service.ts` + `src/http.ts` — 规则的增删改查与启停接口
- `src/web-page.ts` — 网页端「额外限制」页签
- `ui/screens/team.js` + `src/web/server.ts` — 桌面端「额外限制」折叠面板

### 相对归档副本做的三处修正

1. **表名分开**：归档副本的 `011_model_policies.sql` 建的是同名表 `team_model_policies`，
   与基线表结构冲突。新表叫 `team_model_policy_rules`，两张表各司其职。
2. **用量唯一索引带上 team_id**：归档副本的 `(user_id, model, hour_bucket)` 会让同一个人
   在不同团队用同一个模型时互相覆盖计数。
3. **去掉 `role_restriction` 违规类型**：角色不匹配时不产生违规——角色只决定「哪条规则适用」，
   不适用就不参与判定。同时 `created_by` 改为可空且 `ON DELETE SET NULL`，
   成员被删后规则仍然留存。

另外修了一个**归档副本就有的真实缺陷**（与策略系统无关，在 `authenticate()` 里）：
`last_seen_at < $3 - interval '5 minutes'` 会被解析成「参数减区间」，结果是 interval，
比较时报 `operator does not exist: timestamp with time zone < interval`。
在 PGlite 上不报错，**只在真实 PostgreSQL 上暴露**。已改为 `($3::timestamptz - interval '5 minutes')`。

### 接口

```
GET    /v1/teams/:id/model-policy-rules        列出规则
POST   /v1/teams/:id/model-policy-rules        新建
GET    /v1/teams/:id/model-policy-rules/:rid   读取单条
PUT    /v1/teams/:id/model-policy-rules/:rid   修改
DELETE /v1/teams/:id/model-policy-rules/:rid   删除
PUT    /v1/teams/:id/model-policy-rules/enabled          批量启停
PUT    /v1/teams/:id/model-policy-rules/:rid/enabled      单条启停
GET    /v1/teams/:id/model-policy-violations   违规记录
```

### 仍未做

- 归档副本的 `policy-cache.ts`（5 分钟策略缓存 / 30 秒用量缓存）与 `policy-templates.ts`（8 个预设模板）
  没有并入。当前每次调用都直接查库——正确但多一次查询。缓存**不能照搬**：
  归档副本的缓存没有失效钩子，管理员改规则后 5 分钟内不生效，这在这套系统里是不可接受的
  （撤销权限必须立即生效）。若要做缓存，必须绑定策略变更事件主动失效。
- 预设模板：归档副本的模板里硬编码了 `gpt-4`、`claude-3-opus` 等具体模型名，
  与本项目的部署目录机制不匹配，需要重新设计成「按角色限速」这类不绑定具体模型的模板。

### 合并状态（2026-11-20 核对）

归档副本 `src/` 的每个文件都已在权威副本里有对应实现，唯独剩下的 `policy-cache.ts`
是**有意不并入**的（理由见上）。`policy-templates.ts` 已并入，但只取其模板目录接口
（`GET /v1/teams/:id/model-policy-templates`），预设内容按上面说的重新设计，暂未启用。

结论：**两副本合并工作到此结束**，归档副本只作为历史留档，不再有待吸收的素材。

