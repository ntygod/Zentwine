# ZT12-01 执行记录

状态：InProgress（A纯契约代码限定验收通过，文档提交收尾；完整持久边界联调仍Blocked）。父Issue #46，子Issue #47 / PR #48。原ZT03-02前置不删除；Issue #32/#35与Draft PR #33保留。

## 原工作包与独立增量

原范围为统一StartRun、RuntimeEvent、ArtifactManifest、CapabilityReport和错误模型。按[总计划](../plans/00-program-plan.md)的合法固定Fixture并行规则，本轮仅实施无副作用的版本化结构/语义解析、类型、Schema与合成兼容测试；不创建可执行Run、不新增迁移或绕过前置。

A交付记录见[子任务](ZT12-01-A-execution.md)，约定见[ADR-025](../adr/ADR-025-runtime-wire-contracts.md)，使用和边界见[指南](../development/runtime-wire.md)。A最终精确提交验收后只能关闭子Issue #47。

## 父任务未完成条件

版本持久化必须先解决原维护者审查阻断并通过真实数据库验收，再联调revision/hash、主体、策略、租约、预算和批准引用；后续宿主/适配器须消费同一协议并完成实际鉴权、未知结果和产物验证。纯声明一致不是引用存在、权限有效或模型已执行。未满足前父Issue #46保持Open，不把A标为完整ZT12-01或真实多模型完成。

ZT04-03的正文/证据/活动/对话与通用决策、ZT02-06完整文件/预览/导出通道保持各自待办。本轮没有改变这些任务的关闭条件。
