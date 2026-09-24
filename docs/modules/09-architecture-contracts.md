# ZT09｜架构、共享契约与系统地图

状态：Planned。负责人职责：架构、后端、平台、质量。依赖模块：ZT03、ZT06、ZT18。对应蓝图：06.3–06.4、09.4。

## 目标

建立服务、仓库、API、事件、数据与依赖图，使多人和不同模型在共同约定下并行。图区分源码观察、运行观察和批准设计，未知/过时可见。

## 模型和接口

ServiceNode、RepositoryRef、ContractRevision(schema,examples,compatibility)、DependencyEdge(source,observed_at)、ArchitectureDecision、MigrationPlan、CompatibilityWindow。

支持 OpenAPI/事件 schema/数据库迁移等可解析格式；类型与格式转换保持原始来源。系统图不承诺自动发现所有运行时依赖。

API `/system-map`、`/contracts`、`/architecture-decisions`、`/migration-plans`；事件 contract.approved、dependency.observed、compatibility.failed。UI 显示决定依据和影响，不生成永久架构质量分。

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT09-01 | ZT18-01、ZT03-02 | 实现仓库扫描、服务节点和依赖来源模型，保留扫描 commit/覆盖范围 | 未扫描区域显示未知；只读扫描不执行仓库脚本 |
| ZT09-02 | ZT09-01、ZT06-03 | 实现共享接口/事件/数据契约的编辑、版本、评审及引用 | 两工作包可固定同版契约；破坏性变更需要明确决定 |
| ZT09-03 | ZT09-02 | 生成 Mock、桩、类型定义与契约测试，产物版本可追踪 | 同契约生成可重复；前后端不同假设在测试中暴露 |
| ZT09-04 | ZT09-02 | 实现 ADR 多方案、兼容性、维护成本假设和权衡记录 | AI 建议不自动成为批准架构；已采纳方案有负责人 |
| ZT09-05 | ZT09-03、ZT09-04 | 建立跨仓库迁移序列、兼容窗口、发布清单和影响关系 | 不可兼容组合被阻止；不可逆迁移有前向修复/补偿计划 |
| ZT09-06 | ZT09-05 | 系统地图 UI、失效标记、漂移检查和多仓库回归 Fixture | 图可回到源与版本；文本无冲突但契约冲突仍能发现 |

## 测试与发布

测试动态依赖遗漏、循环依赖、重复事件定义、错误 schema、迁移顺序不正确和旧客户端兼容。模型语义疑点仅为候选问题。契约验证引擎可以先提供建议，再对被明确保护的接口启用阻断。
