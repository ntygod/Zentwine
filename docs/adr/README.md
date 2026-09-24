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

- [ADR-010 本地开发生命周期](ADR-010-local-development-lifecycle.md)：统一环境、清理边界、诊断与故障入口。
