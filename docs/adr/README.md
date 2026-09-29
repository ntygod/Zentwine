# 架构决策记录

按所改能力读取一个或少量 ADR；Accepted 是限定设计决定，不等于整个产品已验收。原文中的范围、保留条件与回退有效，不用索引替代原决定。

## 已有记录

| 决策 | 入口 |
|---|---|
| ADR-001｜工程基线与持久工作流 | [决定与状态](ADR-001-engineering-and-orchestration.md) |
| ADR-007｜配置、错误与诊断基础 | [决定与状态](ADR-007-safe-foundations.md) |
| ADR-008｜隔离测试基础与可控 FakeRuntime | [决定与状态](ADR-008-isolated-testkit.md) |
| ADR-009｜可核验的统一工程质量门禁 | [决定与状态](ADR-009-quality-gates.md) |
| ADR-010｜本地开发与故障环境生命周期 | [决定与状态](ADR-010-local-development-lifecycle.md) |
| ADR-011｜持久身份与本机票据会话 | [决定与状态](ADR-011-identity-sessions.md) |
| ADR-012｜统一授权内核与受控资源执行 | [决定与状态](ADR-012-authorization-policy.md) |
| ADR-013｜Agent身份、收窄授权链与调用额度 | [决定与状态](ADR-013-agent-delegation.md) |
| ADR-014｜精确操作审批、职责分离与一次性动作许可 | [决定与状态](ADR-014-bound-approvals.md) |
| ADR-015｜组织生命周期与联邦身份端口 | [决定与状态](ADR-015-organization-lifecycle.md) |
| ADR-016｜组织生命周期审计投影与分页边界 | [决定与状态](ADR-016-organization-audit-view.md) |
| ADR-017｜显式事务绑定的租户数据访问层 | [决定与状态](ADR-017-tenant-data-access.md) |
| ADR-019｜独立交付版本规则与摘要，不携带被阻断迁移 | [决定与状态](ADR-019-version-primitives-increment.md) |
| ADR-020｜共享语义主题与无副作用组件样例 | [决定与状态](ADR-020-shared-visual-foundations.md) |
| ADR-021｜基于服务器会话的组织路由 | [决定与状态](ADR-021-workbench-authorized-navigation.md) |
| ADR-022｜授权目录对象页与最小布局偏好 | [决定与状态](ADR-022-authorized-object-page.md) |
| ADR-023｜目录改名的独立审批交互 | [决定与状态](ADR-023-catalog-approval-workflow.md) |
| ADR-024｜目录审批的受控发现与创建界限分页 | [决定与状态](ADR-024-approval-inbox.md) |
| ADR-025｜供应商中立运行契约与非授权兼容声明 | [决定与状态](ADR-025-runtime-wire-contracts.md) |
| ADR-026｜连续前缀运行观察与执行权分离 | [决定与状态](ADR-026-runtime-event-observer.md) |
| ADR-027：显式有界运行事件字节流 | [决定与状态](ADR-027-runtime-event-byte-stream.md) |
| ADR-028：运行输入产物的本地字节完整性与一次性交接 | [决定与状态](ADR-028-runtime-input-artifact.md) |
| ADR-029｜报告与字节绑定的单产物交接 | [决定与状态](ADR-029-runtime-artifact-handoff.md) |
| ADR-030：多输入整批本地交接 | [决定与状态](ADR-030-runtime-input-bundle.md) |
| ADR-031：先把交接检查接入 Studio 的显式本地入口 | [决定与状态](ADR-031-studio-local-inspection.md) |
| ADR-032：终端交接包只读检查 | [决定与状态](ADR-032-terminal-runtime-inspection.md) |
| ADR-033：本地 Git 固定提交只读端口 | [决定与状态](ADR-033-local-git-read-port.md) |
| ADR-034：本地工作树原始观察 | [决定与状态](ADR-034-local-worktree-observation.md) |
| ADR-035｜固定提交直接树比较与逐文件披露 | [阅读](ADR-035-fixed-commit-comparison.md) |
| ADR-036｜Studio导入比较报告审阅 | [阅读](ADR-036-studio-comparison-review.md) |
| ADR-037｜原报告绑定的本地文件意见交接 | [阅读](ADR-037-local-review-notes.md) |
| ADR-038｜多份意见的显式预览合并 | [阅读](ADR-038-local-review-merge.md) |
| ADR-039｜本地Git核对与按需意见读取 | [阅读](ADR-039-local-review-feedback.md) |

## 仅有规划占位的提案

ADR-002（权威版本/outbox/inbox/租户）、003（工作区写入/租约）、004（供应商与双基座）、005（独立验证证据）、006（自治/插件授权）仍是原索引中的 Proposed 槽位，并无同名 ADR 文件。后续相关增量见上表，不能自动视为这些完整提案已接受。编号缺口不补写为历史决定。

项目负责人已授权普通技术决策和推进；实施者必须记录依据，不伪称第三方独立审批。新增决定使用 [模板](../templates/adr.md)，更新本索引并关联实际任务。
