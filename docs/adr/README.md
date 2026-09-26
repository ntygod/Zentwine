# 架构决策记录

项目负责人已在项目对话授予技术决策和开发推进权限，实施者作出的决定必须记录依据，不伪称第三方独立审批。

| ADR | 当前状态 | 内容 |
|---|---|---|
| [ADR-001](ADR-001-engineering-and-orchestration.md) | Accepted | TypeScript 主工程、PostgreSQL 业务权威、Temporal 持久流程方向；生产条件单独验证 |
| ADR-002 | Proposed | 权威版本、outbox/inbox、租户与一致性 |
| ADR-003 | Proposed | Studio 工作区写入控制、断线与租约 |
| ADR-004 | Proposed | 供应商兼容、真实双基座验证 |
| ADR-005 | Proposed | 独立验证与版本证据 |
| ADR-006 | Proposed | 自治、插件及授权边界 |
| [ADR-007](ADR-007-safe-foundations.md) | Accepted | 配置、安全错误、请求追踪、时间/ID 与诊断脱敏 |
| [ADR-008](ADR-008-isolated-testkit.md) | Accepted（测试基础） | FakeRuntime、租户Fixture、独立临时PG库与测试清理 |

未明确接受的提案不自动变成已实现能力。可使用 [ADR 模板](../templates/adr.md)。

- [ADR-009 质量门禁](ADR-009-quality-gates.md)：仓库门禁、制品摘要与平台权限边界。
- [ADR-010 本地开发生命周期](ADR-010-local-development-lifecycle.md)：统一环境、清理边界、诊断与故障入口。

- [ADR-012 统一授权](ADR-012-authorization-policy.md)：精确资源策略、事务授权与多入口一致性。

- [ADR-011 本机身份](ADR-011-identity-sessions.md)：一次性票据、持久会话和可信组织上下文。
- [ADR-013 Agent授权链](ADR-013-agent-delegation.md)：责任人、收窄授权、额度预留、快照与撤权。

- [ADR-014 版本绑定审批](ADR-014-bound-approvals.md)：一次性动作许可、职责分离与撤权通知。
- [ADR-015 组织生命周期](ADR-015-organization-lifecycle.md)：组织治理、访客、邀请及联邦身份适配边界。
- [ADR-016 审计投影](ADR-016-organization-audit-view.md)：已实现组织历史的只读白名单、分页及迁移回退限制；不是完整审计账本。

- [ADR-017：租户数据访问](ADR-017-tenant-data-access.md)：事务绑定、强制RLS与运行/迁移身份边界。
