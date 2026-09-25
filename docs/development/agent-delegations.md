# Agent身份与授权链开发指南

工作包ZT02-03；支持范围为本机可信开发。不是Claude/Codex接通、生产认证或预算计费交付。

## 前置和启用

先完成[身份服务](identity-sessions.md)和[资源策略](authorization-policy.md)的本机数据库、角色及允许来源配置。保持默认`pnpm dev`不变；它不自动开启身份/策略/Agent，不自动迁移。

在明确的开发身份库中，先按既有清单应用0001、0002，再由迁移/操作员角色在显式事务内执行`packages/db/migrations/0003-agent-delegations.up.sql`及verify。更新迁移清单记录，不允许重跑已存在DDL来掩盖不一致。不要指向生产DATABASE_URL。

保持已有`ZENTWINE_IDENTITY_OPERATOR_URL`与`ZENTWINE_IDENTITY_OPERATOR_ACK=local-development-only`设置，新增运行角色权限：

```bash
printf '%s' '{"action":"grant-runtime"}' | pnpm agents:admin
ZENTWINE_POLICY_MODE=local ZENTWINE_AGENT_MODE=local pnpm identity:serve
```

启动使用`ZENTWINE_DATABASE_URL`运行角色连接，而不是操作员连接。运行角色可以新增身份/授权/快照/回执，仅获准更新停用/撤销/额度计数；不能修改身份责任人、快照、回执或凭据摘要。权限不符合要求则启动失败。

## 人类控制接口

均使用既有会话Cookie、组织context_version；POST还需精确允许Origin、`x-zentwine-client:web`、CSRF和JSON。责任人取自会话，不能由请求指定。

| 方法与路径（前缀`/api/v1/orgs/:orgId`） | 输入 | 含义 |
|---|---|---|
| POST `/agents` | request_id、display_name | 登记自己的Agent，重复request_id+同内容返回原记录 |
| POST `/agents/:agentId/disable` | expected_version | 不可逆停用，保留责任与历史 |
| POST `/delegations` | request_id、agent_id、terms | 为自己的Agent签发根授权 |
| GET `/delegations/:delegationId` | 无 | 责任人读取自己的授权及历史快照，不开始执行 |
| POST `/delegations/:delegationId/revoke` | expected_version | 撤销目标，后代下一调用重新检查祖先 |

`terms`包含scopes、not_before、expires_at、max_calls、max_depth；时间为UTC Unix毫秒整数。首次开始时间可比服务器时间早最多60秒以容忍传输，结束不得超过服务器当前时间8小时。每个scope为resource_id、actions、environment。必须含resource.read，未实现的模型/文件/部署动作不能通过伪造operation执行。

允许的actions沿用ZT02-02的固定目录；签发时所有动作都必须被当前策略允许，needs_approval不能变成授权。组织至少已有一个资源策略记录，再登记Agent。Agent显示名不是模型标识，本轮不自动选择或调用任何模型。

签发结果包括created、delegation、credential和credential_recoverable:false。credential只在首次成功返回，格式`zt_agent_`加随机不透明秘密。重试返回credential:null，不会再次预留额度。响应丢失时读取/撤销旧记录，再显式新建；不要无限创建根授权。

## Agent执行接口

仅受信任本机Runner/工具桥使用`Authorization: Bearer <credential>`，拒绝浏览器Origin、Cookie及Fetch Metadata。凭据不能放在URL或工具参数。绑定工具`createAgentTools`复制服务端scope；实际Agent不能访问数据库或自行创建scope。

| 方法与路径 | 内容 |
|---|---|
| GET `/api/v1/agent/self` | 验证当前及全部祖先后返回自身授权/预算/快照，不消耗目录调用额度 |
| POST `/api/v1/agent/delegate` | 为同一责任人已经登记的另一个Agent签发更窄子授权 |
| POST `/api/v1/agent/tools` | catalog.read或catalog.rename；每次验证授权并按request_id幂等执行 |

工具参数始终带request_id、resource_id、operation；改名还需display_name、expected_version、expected_policy_revision。角色、责任人、预算扣减金额、外部批准及环境参数均不是工具可自报的事实。服务器固定每个成功目录操作扣1次额度；不是由模型报数。

重试成功的操作返回`replayed:true`与历史回执，**不是资源最新状态**。最新状态应使用新request_id执行新的读取（会消耗一次调用）。已撤销/失效授权不能借旧request_id读取旧回执。被拒绝/回滚不扣额度；消费与目录修改及回执同事务。

## 预算和撤权语义

父级100次，分配子级60次后，父级剩40次；子级还能把60次中的20次分配孙级。不能额外再给兄弟分配60次。撤销子级也不自动退回已分配额度。

max_depth是剩余可用链深（包含当前节点），每次委派严格减少。最多8层，每棵树最多128节点，每条授权最多16个明确资源。不能在同一祖先链里重复出现同一Agent。

任何祖先撤销/到期/停用，或责任人身份/成员/组织/策略绑定版本变化，后续调用失效。策略更新采用保守失效（含无关资源导致的组织policy_revision变化），由人重新签发根授权；不自动把扩大后的权限灌入旧Agent。

浏览器logout不取消独立委派，退出登录与取消任务必须分开呈现；人类身份停用则阻断后续调用。已有写操作持锁时，撤权等待它先提交，然后后续调用拒绝。断开HTTP连接不保证取消已提交事务。

## 验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:agents
# 需已确认的专用测试PG环境变量及服务器guard
pnpm test:agents-integration
```

缺少测试数据库配置会失败而不是skip。集成套件建隔离数据库并配置非特权角色，正常finally回收；不向真实身份库播种。`pnpm test:live`继续单独报告模型未执行。

范围、失败记录和最终证据见[验证报告](../testing/zt02-03-report.md)。数据迁移不可等同生产迁移，操作员CLI不等同完整开户UI；实际模型Token/费用、持久审计与OS工作区由后续模块扩展。
