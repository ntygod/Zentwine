# Zentwine 开发文档导航

版本：Development Plan 1.0｜日期：2026-09-24｜状态：待团队评审的实施基线。

本文档拆解完整终态，不是首版功能清单。所有工作项初始状态为 Planned；任务负责人以职责占位，未擅自分配真实成员或工期。

## 推荐阅读顺序

| 文档 | 解决的问题 |
|---|---|
| [00 总计划](plans/00-program-plan.md) | 最终建设什么，依赖与建设波次怎样组织 |
| [01 范围追踪](plans/01-scope-and-traceability.md) | 原蓝图每项能力是否有去向 |
| [02 架构](plans/02-architecture.md) | 服务、应用、包与基础设施怎样划分 |
| [03 领域和状态](plans/03-domain-and-states.md) | 谁拥有数据，状态怎样合法推进 |
| [04 接口和事件](plans/04-api-events-contracts.md) | 各团队如何并行开发而不各自猜接口 |
| [05 UI 与 Studio](plans/05-ux-and-studio.md) | 独立 Coding 界面如何衔接管理端 |
| [06 测试与验收](plans/06-quality-and-acceptance.md) | 怎样证明完成和防止伪完成 |
| [07 安全与运维](plans/07-security-and-operations.md) | 怎样限制权限、隔离执行和恢复故障 |
| [08 执行手册](plans/08-execution-guide.md) | 人和不同基座怎样领取任务、提交代码 |
| [09 决策风险与资料](plans/09-decisions-risks-sources.md) | 哪些是建议，哪些需要验证或批准 |

## 模块计划

| ID | 模块 | 文档 |
|---|---|---|
| ZT01 | 工程底座与 CI | [01](modules/01-foundation.md) |
| ZT02 | 身份、组织与授权 | [02](modules/02-identity-policy.md) |
| ZT03 | 领域版本、事件与审计 | [03](modules/03-domain-events.md) |
| ZT04 | 设计系统与管理应用外壳 | [04](modules/04-design-system.md) |
| ZT05 | 产品机会、目标与实验 | [05](modules/05-discovery-goals.md) |
| ZT06 | 需求、决策与规格 | [06](modules/06-specifications.md) |
| ZT07 | 全链路变更驾驶舱 | [07](modules/07-change-control.md) |
| ZT08 | 原生设计与可运行原型 | [08](modules/08-design-prototype.md) |
| ZT09 | 架构、契约与系统地图 | [09](modules/09-architecture-contracts.md) |
| ZT10 | 项目组合、容量与项目沙盘 | [10](modules/10-project-portfolio.md) |
| ZT11 | 知识、搜索与上下文 | [11](modules/11-knowledge-context.md) |
| ZT12 | 模型与运行时协议 | [12](modules/12-runtime-protocol.md) |
| ZT13 | Claude Agent SDK 适配 | [13](modules/13-claude-adapter.md) |
| ZT14 | Codex 适配 | [14](modules/14-codex-adapter.md) |
| ZT15 | Runner、环境与写入控制 | [15](modules/15-runner-workspace.md) |
| ZT16 | 多模型编排与协作通信 | [16](modules/16-orchestration.md) |
| ZT17 | 独立 Coding 工作台 Studio | [17](modules/17-studio.md) |
| ZT18 | 仓库、代码评审与跨库集成 | [18](modules/18-code-management.md) |
| ZT19 | 独立验证与交付证据 | [19](modules/19-quality-evidence.md) |
| ZT20 | 发布、运营与事故协作 | [20](modules/20-release-operations.md) |
| ZT21 | 模型实验室与路由评估 | [21](modules/21-model-lab.md) |
| ZT22 | 目标自治与持续执行 | [22](modules/22-autonomy.md) |
| ZT23 | 工作流、技能与扩展生态 | [23](modules/23-workflow-marketplace.md) |
| ZT24 | 连接器与联邦同步 | [24](modules/24-connectors-federation.md) |
| ZT25 | 团队协作、客户门户与移动审批 | [25](modules/25-collaboration-portal.md) |
| ZT26 | 成本、治理与商业管理 | [26](modules/26-governance-economics.md) |
| ZT27 | 云、私有化与可靠性工程 | [27](modules/27-platform-operations.md) |
| ZT28 | 效果分析与组织学习 | [28](modules/28-outcomes-learning.md) |
| ZT29 | 桌面、CLI 与外部 IDE | [29](modules/29-desktop-cli-ide.md) |
| ZT30 | 接入、迁移、导出与采用体验 | [30](modules/30-onboarding-migration.md) |

## 配套交付

[任务索引](tasks/README.md)｜[端到端场景](tests/end-to-end.md)｜[ADR 决策记录](adr/README.md)｜[任务模板](templates/work-item.md)｜[PR 模板](templates/pull-request.md)。

示例契约位于 `contracts/`，是 Zentwine 自有协议的设计示例，不是 Claude/Codex SDK 的真实接口。机器可读任务索引用于创建 Issue 草稿；本次未批量创建 Issues、未部署应用、未调用付费 Agent 执行。

## 当前已实现范围的使用入口

上述内容是完整终态规划；现行交付按[实施状态](tasks/status.md)与GitHub PR/Issue核对，不根据规划清单判断完成。ZT02-06的A/B/C已分别合并，完整文件/预览/导出验收仍保留：

[权限矩阵与证据](development/access-matrix.md)｜[组织审计使用指南](development/organization-audit.md)｜[审计设计决策](adr/ADR-016-organization-audit-view.md)｜[B验收补录](testing/zt02-06-b-report.md)｜[成员应急访问控制](development/emergency-containment.md)｜[完整通道验收待办](tasks/zt02-06-acceptance-followup.md)。

这些入口不代表生产身份认证、完整安全账本、文件业务或真实多模型协作已经完成。
