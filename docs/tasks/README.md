# 可领取开发任务索引

共 30 模块 × 6 工作包 = 180 个任务。初始状态全部 Planned，尚未分配真实人员、日期或 GitHub Issue。详细前置、交付与验收以模块内表格为准。

任务不是预估天数，也不是可自动忽略评审的大批量提示词。领取前遵循 [执行手册](../plans/08-execution-guide.md)。

| 模块 | 工作项范围 | 入口 |
|---|---|---|
| 工程底座 | ZT01-01–ZT01-06 | [计划](../modules/01-foundation.md) |
| 组织授权 | ZT02-01–ZT02-06 | [计划](../modules/02-identity-policy.md) |
| 版本事件 | ZT03-01–ZT03-06 | [计划](../modules/03-domain-events.md) |
| 应用设计系统 | ZT04-01–ZT04-06 | [计划](../modules/04-design-system.md) |
| 机会目标实验 | ZT05-01–ZT05-06 | [计划](../modules/05-discovery-goals.md) |
| 需求规格 | ZT06-01–ZT06-06 | [计划](../modules/06-specifications.md) |
| 变更驾驶舱 | ZT07-01–ZT07-06 | [计划](../modules/07-change-control.md) |
| 设计原型 | ZT08-01–ZT08-06 | [计划](../modules/08-design-prototype.md) |
| 架构契约 | ZT09-01–ZT09-06 | [计划](../modules/09-architecture-contracts.md) |
| 项目组合沙盘 | ZT10-01–ZT10-06 | [计划](../modules/10-project-portfolio.md) |
| 知识上下文 | ZT11-01–ZT11-06 | [计划](../modules/11-knowledge-context.md) |
| 运行时协议 | ZT12-01–ZT12-06 | [计划](../modules/12-runtime-protocol.md) |
| Claude 适配 | ZT13-01–ZT13-06 | [计划](../modules/13-claude-adapter.md) |
| Codex 适配 | ZT14-01–ZT14-06 | [计划](../modules/14-codex-adapter.md) |
| Runner 工作区 | ZT15-01–ZT15-06 | [计划](../modules/15-runner-workspace.md) |
| 异构协作 | ZT16-01–ZT16-06 | [计划](../modules/16-orchestration.md) |
| 独立 Studio | ZT17-01–ZT17-06 | [计划](../modules/17-studio.md) |
| 代码管理 | ZT18-01–ZT18-06 | [计划](../modules/18-code-management.md) |
| 独立验证 | ZT19-01–ZT19-06 | [计划](../modules/19-quality-evidence.md) |
| 发布运营 | ZT20-01–ZT20-06 | [计划](../modules/20-release-operations.md) |
| 模型实验室 | ZT21-01–ZT21-06 | [计划](../modules/21-model-lab.md) |
| 目标自治 | ZT22-01–ZT22-06 | [计划](../modules/22-autonomy.md) |
| 流程生态 | ZT23-01–ZT23-06 | [计划](../modules/23-workflow-marketplace.md) |
| 联邦连接 | ZT24-01–ZT24-06 | [计划](../modules/24-connectors-federation.md) |
| 协作门户移动 | ZT25-01–ZT25-06 | [计划](../modules/25-collaboration-portal.md) |
| 治理成本 | ZT26-01–ZT26-06 | [计划](../modules/26-governance-economics.md) |
| 部署运维 | ZT27-01–ZT27-06 | [计划](../modules/27-platform-operations.md) |
| 效果学习 | ZT28-01–ZT28-06 | [计划](../modules/28-outcomes-learning.md) |
| 桌面 CLI IDE | ZT29-01–ZT29-06 | [计划](../modules/29-desktop-cli-ide.md) |
| 接入迁移退出 | ZT30-01–ZT30-06 | [计划](../modules/30-onboarding-migration.md) |

## 依赖解释

模块依赖是完整联调的输入，不表示所有任务必须等全部上游完成才可写代码。任务表给更细前置；没有表出的共同前置仍包括身份、版本、安全与公共契约。并行实现可用固定 Fixture，但合并门禁不能将 Fake 当真实业务结果。

关键前置需要特别调度：ZT26-01/02 的预算原语在真实运行前完成；ZT27 基础隔离与日志在 W1 建设；ZT07/09 变更与接口契约在 W2 联调前冻结；完整高级页面不阻碍这些底座先行。

## 机器可读清单

仓库附 `scripts/validate_plans.py`，执行 `python scripts/validate_plans.py --export /tmp/zentwine-backlog.json` 可从规范表格导出任务、依赖、交付和验收 JSON，同时检查 ID、链接、依赖环和数量。只读校验不创建 GitHub Issues，也不执行真实 Agent。

后续导入 Issue 时先生成草稿、按任务 ID 查重，再由用户明确启动写入；不把当前计划当作已排期承诺。
