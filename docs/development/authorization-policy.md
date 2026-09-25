# ZT02-02｜授权与资源目录开发指南

本轮增加真正持久化的授权元数据和执行检查，不增加项目看板、Studio 文件编辑或模型执行。默认 `pnpm dev` 仍是无数据库的只读壳。参见 [身份指南](identity-sessions.md) 和 [ADR-012](../adr/ADR-012-authorization-policy.md)。

## 启用与数据

首先按身份指南准备本机 `zentwine_identity_dev`、操作员和 `zt_identity_app`。通过已有 `pnpm identity:admin` 的 `migrate` 动作显式应用迁移；新 0002 包含 organization_policies / resources / role_bindings / resource_grants。旧 0001 不覆盖。然后给 `pnpm policy:admin` 的 stdin 传入 `{"action":"grant-runtime"}`，仅授予策略读取与资源 display_name/object_version 修改。

已有 `ZENTWINE_IDENTITY_MODE=local-ticket`、本机 DSN 和精确允许来源配置之外，设置 `ZENTWINE_POLICY_MODE=local` 后执行 `pnpm identity:serve`。disabled 或未设置不启用授权路由；生产身份模式仍不可启动。本轮没有新增公共账号或策略管理员旁路。

策略操作员沿用 `ZENTWINE_IDENTITY_OPERATOR_ACK=local-development-only` 和 `ZENTWINE_IDENTITY_OPERATOR_URL`，接受 stdin JSON，不从 CLI 参数读取凭据。支持 register-resource、add-rule、revoke-rule、write-mode、grant-runtime。修改策略必须携带 expected_revision，冲突需要重读，不能自动覆盖。

资源注册输入示意（UUID 替换为已配置的真实本机组织；不是可直接运行的生产配置）：

```json
{"action":"register-resource","resource":{"org_id":"<organization-uuid>","kind":"workspace","display_name":"本机工作区权限元数据","visibility":"organization","environment":"development","sensitivity":"internal","owner_human_id":null,"status":"active"}}
```

注册返回资源 UUID；对象初始版本 1。它不会建立真正文件工作区或 Runner。角色绑定含 org_id、human_id、resource_id、role(reader/editor)、valid_from(UTC epoch 毫秒)、expires_at(null或毫秒)。资源授权用 action 与 effect(allow/deny) 代替 role。所有关联必须属于同一组织，并关联存在的成员。

组织 member/owner 可修改组织可见的开发环境目录名称，viewer 只读。受限资源需要所有者关系或精确绑定/授权；组织 owner 不自动获得全部私有资源。显式 deny 优先。read_only 阻止写入；生产写入、非 owner 的预发写入、保密数据导出和 release.deploy 进入 needs_approval。精确 allow 不能绕过这些约束。

## HTTP

Cookie、CSRF 和组织切换沿用身份模块。请求包含 `X-Zentwine-Context-Version`；变更请求包含精确 Origin、`X-Zentwine-Client:web`、`X-Zentwine-Csrf` 和 application/json。

| 入口 | 用途 |
|---|---|
| POST `/api/v1/orgs/:orgId/policy/evaluate` | `{resource_id,action}`，只评估，不执行 |
| GET `/api/v1/orgs/:orgId/resources/:resourceId` | 读取目录元数据，不打开工作区或启动 Run |
| PATCH 同上 | `{display_name,expected_version,expected_policy_revision}`，受控修改目录名称 |

已知 action：resource.read/update/export、workspace.write、repository.write、release.deploy。后面三个不是已经完成的文件、代码或部署工具。未注册动作返回 deny/unknown_action；不存在、跨组织和无读取权限资源使用相同 unavailable_resource 错误。不能在正文添加 role、principal、environment 或 approval 提权。

`PolicyDecision` 包含 policy_version、policy_revision、membership_version、resource_version、evaluated_at、expires_at 和 `reusable:false`。到期时间最长 15 秒且不超过相关事实边界，仅作诊断，不能缓存用于执行。PATCH 输出的 decision 描述变更前被核验版本，resource 是变更后版本。重复预期版本写入冲突，不重复修改；本轮没有一般化命令幂等账本。

## 工具与 WebSocket

服务器调用 `createCatalogTools(repository,scope)` 绑定作用域，只向调用者暴露 invoke。模型或外部调用者不能创建权威 scope。命令格式：`{operation:"catalog.read",resource_id}` 或 `{operation:"catalog.rename",resource_id,display_name,expected_version,expected_policy_revision}`。每次 invoke 都重新访问权威仓储；无客户端策略缓存。

真实 WS 路径 `/api/v1/policy/socket?org_id=<UUID>&context_version=<版本>`。握手需已有会话 Cookie 和精确允许 Origin，首条及后续 JSON 文本消息均为上述工具命令另加 csrf_token。秘密不能放在 URL 或子协议。返回 type=result 加资源/决策，或 type=error 加标准安全错误。一个连接一次只允许一条未完成命令；同会话最多 4 个连接、服务最多 32 个升级连接、负载 8 KiB、每分钟 60 条消息。无业务数据握手推送。

会话/组织切换、注销和成员撤销后下一条消息重核并拒绝，部分认证或上下文错误关闭连接；定期复查最长约10秒，不提供实时推送撤权SLA。原始 URL/消息和凭据不写日志。断开连接不回滚已受理操作，不能盲目重试写入。服务关闭清理升级连接；这是本机目录协议而非多租户生产 WebSocket 网关。

## 验证与边界

- `pnpm test:policy`：确定性的纯策略与工具入参测试，不调用模型。
- `pnpm test:policy-integration`：专用测试 PostgreSQL + 非特权运行角色；包含 HTTP、真实 TCP WebSocket、提交、回滚与撤权。按[测试指南](testkit.md)准备环境，缺配置明确失败。
- `pnpm check` 和完整 CI 保留原检查；浏览器原9场景不算新增权限UI验收。

资源目录不是完整业务 RLS。数据库运行身份不具有治理写权限，但它是可信控制面进程，不能让不可信模型代码使用其数据库连接。advisory lock 只约束遵守协议的仓储，数据库管理员可绕过；后续仓储修改必须使用相同锁顺序。授权成立的检查点不能追溯撤回已发生动作。

普通API请求无后台触碰会话空闲时间；需要用户主动的会话读取或轮换来更新既有空闲期限，WS后台复查不会无限续命。暂无跨进程策略缓存、审计持久化、Agent身份、审批签发、SSO或公网部署。
