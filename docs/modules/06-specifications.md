# ZT06｜需求、决策与版本化规格

状态：Planned。负责人职责：产品、后端、编辑器前端、质量。依赖模块：ZT03、ZT04。对应蓝图：05。

## 目标与规则

需求是结构化的规则、场景、验收项与范围，也可呈现为文档。讨论生成候选内容，批准才形成权威版本。探索与设计允许往返，不强制一次写完所有未知。

## 数据和接口

DeliveryUnit、SpecRevision(parent_ids,canonical_content,hash,status)、BusinessRule、AcceptanceCriterion(stable_key,method,owner)、OpenQuestion、Decision、Exception。草稿共同编辑记录与不可变批准版本分离。

`/deliveries`、`/specs/{id}/drafts`、`/spec-revisions/{id}/submit`、`/spec-revisions/{id}/approve`、`/specs/{id}/diff`；事件 spec.revision_approved、spec.retired、question.resolved。客户侧 Markdown 是导出或提案，不默认另一个权威副本。

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT06-01 | ZT03-02 | 实现交付单元、规格、规则、验收项和未决问题模型与 CRUD | 稳定验收 ID 跨版本可追踪；范围排除和验收方式可存取 |
| ZT06-02 | ZT06-01、ZT04-03 | 实现文档/结构化双视图、草稿协同编辑和评论锚点 | 并发编辑无静默覆盖；批准正文不会被后续 CRDT 更新 |
| ZT06-03 | ZT06-02、ZT02-04 | 实现评审、批准、分支合并、废弃与例外策略 | 两版竞争批准有冲突处理；新内容不能复用旧批准 |
| ZT06-04 | ZT06-01 | 实现需求健康检查及澄清 Agent 工具，输出确定/可能/缺资料三类问题 | 不凭模型评分阻止全部工作；关键业务冲突需要负责人决定 |
| ZT06-05 | ZT06-03 | 实现任务上下文引用、Markdown/JSON 导出与外部编辑提案 | 导出携带 revision/hash；外部改动不能覆盖 approved；重新导入可定位差异 |
| ZT06-06 | ZT06-03、ZT06-05 | 建立完整需求验收测试、版本迁移及变化事件 Fixture | 旧规格引用可查；删除遵循保留策略；新验收不能自动被旧测试满足 |

## 异常与测试

规格并发批准、验收项删除、评论引用过时、跨租户关联、失去批准权限、离线草稿回传均测试。无法确定的字段显示未决，不让不同模型分别补成不同业务承诺。

## 完成和回退

需求→评审→批准→导出→变更提案链路通过；所有写入审计；数据迁移保留版本历史。关闭 AI 助手后人工编辑与批准仍可使用，避免整个产品被单一供应商故障阻断。
