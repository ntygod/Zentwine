# ZT03-02 执行记录

整体状态：InProgress（A独立交付，B迁移与持久验收仍Blocked）。父任务Issue #32保持打开，不推进ZT03-03。

基线main `4cda38a41bcbf76856bc8c9a801525c9482037cd`。原PR #33、head `9ba7a29aeaf58b569454a52413b2167c9b78ef07` 仍为数据库候选草稿，CI `36221177636` 实际failure：0009-up unsupported_migration_statement，下游完整工程/PG/浏览器/持久性未执行。被拦截门禁扩展不在此增量重试，也不改变历史失败结论。

本轮A交付规范化、SHA-256摘要、版本/关系/命令类型、有限转换规则及同步深度冻结命令快照；参见[开发说明](../development/version-primitives.md)与[ADR-019](../adr/ADR-019-version-primitives-increment.md)。Node摘要适配不访问数据库，TenantUnitOfWork保持原样；新PG、真实CAS、不可变正文或批准持久化均未在A实现。

新增26项测试，其中8个独立生成固定黄金样本；显式检查36种状态/动作组合，以及尺寸、Unicode、深度、节点、访问器、关系上限和深拷贝。本地Node22定向26/26及domain/单文件摘要编译通过；本地并非冻结目标环境。新增测试通过现有tests/*.test.mjs自动接入全量工程CI。最终目标环境结果、精确head、制品与合并以本轮独立PR为准，不能沿用PR31或PR33的结果。

未修改原门禁、工作流、八项历史迁移、依赖锁或旧测试，不携带0009。A合并不关闭Issue32：B必须整合A导出、解决迁移兼容、执行原32项真实PG及所有回归、核对最终制品后另行验收。Issue #25的文件/预览/导出完整业务通道待办仍保留；无生产迁移/部署、真实模型/IdP或付费操作。
