# 版本绑定审批开发指南（ZT02-04）

## 已实现范围

纯规则、数据库审批仓储、本机HTTP入口与服务器绑定工具适配。仅执行资源目录改名，不触及代码、文件、发布、模型账户或Agent额度。默认pnpm dev与bootstrap契约不变。

先按[身份指南](identity-sessions.md)、[授权指南](authorization-policy.md)、[Agent指南](agent-delegations.md)准备本机数据库和运行角色。显式应用0004迁移，操作员运行`pnpm approvals:admin`（stdin `{"action":"grant-runtime"}`），只增加固定zt_identity_app角色的最小权限；不自动迁移，不公开HTTP管理入口。沿用ZENTWINE_IDENTITY_OPERATOR_ACK和独立操作员URL；不可把连接串发给模型。

```bash
ZENTWINE_POLICY_MODE=local ZENTWINE_AGENT_MODE=local ZENTWINE_APPROVAL_MODE=local pnpm identity:serve
```

## 流程与接口

所有路径均以`/api/v1/orgs/:orgId`为前缀，使用既有会话Cookie、准确Origin和x-zentwine-context-version；写入还需JSON、x-zentwine-client:web、会话绑定CSRF。拒绝Bearer混用、额外权威字段和URL秘密。

| 方法与路径 | 行为 |
|---|---|
| POST /approvals | request_id、resource_id、operation:catalog.rename、display_name、expected_version、expected_policy_revision、review:required/policy |
| GET /approvals/:id | 返回固化命令、版本、决策来源和可能存在的历史回执；只读，不消费许可 |
| POST /approvals/:id/decide | expected_version、content_hash、outcome:approve/reject；独立有资格owner决策 |
| POST /approvals/:id/permit | 原请求人使用expected_version、content_hash领取短期许可；只返回一次秘密 |
| POST /approvals/:id/execute | expected_version（审批版本）、content_hash、resource_id、operation、display_name、expected_resource_version、expected_policy_revision和permit |
| POST /approvals/:id/revoke | 使用审批expected_version与content_hash撤销尚未完成的审批 |
| GET /approval-events?after=0&limit=50 | 当前请求人或已记录审批者的持久通知；next_cursor为字符串，不是JS浮点数 |

数据库计算权威环境和内容摘要；不接受调用者声称approved、role、requester_id或environment。审批返回reusable:false；批准记录不是可重复调用凭据。期限为请求15分钟、动作许可最多2分钟；自然到期时底层state可能仍为issued，实际执行会拒绝，不能仅根据state判断可执行。

状态：pending → approved → issued → consumed；pending可reject，未完成可revoke。review=policy在开发环境可能直接产生策略预授权，而生产目录操作仍需另一位owner批准；这里production只是目录资源元数据，不会部署生产软件。

后端createApprovedCatalogTool只接受服务端绑定人类scope、approvalId和许可摘要；模型不能构造这些绑定，不是MCP或Agent已接通。ZT02-03委派的needs_approval仍拒绝签发，不自动把本许可转成广泛Agent权限。

## 通知、重试与撤权

请求创建相同request_id且输入相同可恢复记录；改变输入冲突。批准、领证和执行重放均拒绝；领证返回丢失后撤销旧请求并新建。执行返回丢失后GET审批查回执，不自动重新执行。历史回执不是资源最新状态。

事件与业务事务同提交。after游标用于至少一次读取与去重，轮询没有硬实时SLA；退出登录或组织权限无效后不能继续读取。撤权判断不依赖客户端收到通知。审批者被停用/降权、身份和组织版本变化以及策略修改，通过合作治理入口原子撤销相关未完成审批。新数据库表写入失败时不能假装撤权成功。

策略数据和管理员SQL属于可信控制面，不能给Agent数据库连接。普通资源变化及自然到期在执行时检查，但不自动广播所有此类变化。全部生产和Agent运行能力保持未完成标记。

## 验证与回退

```bash
pnpm check
pnpm test:approvals
# 专用测试PG就绪，沿用显式确认标记；缺少配置会失败
pnpm test:approvals-integration
```

新套件使用隔离合成数据与真实PG，测试持久审批、拒绝、重放、并发、撤权、回滚、游标和真实TCP。原浏览器场景仅旧界面回归，不是审批UI验收。详情见[验证记录](../testing/zt02-04-report.md)。

回退时先关闭审批模式并停止旧实例；保留数据库可恢复使用。有损down不自动用于真实数据，DDL操作员与运行角色分离。
