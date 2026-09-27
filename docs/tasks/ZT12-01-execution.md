# ZT12-01 执行记录

状态：InProgress（A/A2已由PR #48/#50合并，A3字节流消费者验收中；完整持久边界联调仍Blocked）。父Issue #46，子Issue #47 / PR #48。原ZT03-02前置不删除；Issue #32/#35与Draft PR #33保留。

## 原工作包与独立增量

原范围为统一StartRun、RuntimeEvent、ArtifactManifest、CapabilityReport和错误模型。按[总计划](../plans/00-program-plan.md)的合法固定Fixture并行规则，本轮仅实施无副作用的版本化结构/语义解析、类型、Schema与合成兼容测试；不创建可执行Run、不新增迁移或绕过前置。

A交付记录见[子任务](ZT12-01-A-execution.md)，约定见[ADR-025](../adr/ADR-025-runtime-wire-contracts.md)，使用和边界见[指南](../development/runtime-wire.md)。A最终精确提交已验收合并，子Issue #47已关闭。

新增[A2事件观察器](ZT12-01-A2-execution.md)由Issue #49 / PR #50跟进：消费同一wire协议，处理实例内顺序/重复/缺口/未知与终态，固定Fixture并行实现，不创建执行宿主或持久状态。A2最终验收与合并以PR #50为准，不能替代以下父任务关闭条件。

## 父任务未完成条件

版本持久化必须先解决原维护者审查阻断并通过真实数据库验收，再联调revision/hash、主体、策略、租约、预算和批准引用；后续宿主/适配器须消费同一协议并完成实际鉴权、未知结果和产物验证。纯声明一致不是引用存在、权限有效或模型已执行。未满足前父Issue #46保持Open，不把A标为完整ZT12-01或真实多模型完成。

ZT04-03的正文/证据/活动/对话与通用决策、ZT02-06完整文件/预览/导出通道保持各自待办。本轮没有改变这些任务的关闭条件。

## A3：事件字节流消费者

继PR #50只读观察器后，Issue #51推进严格UTF-8/NDJSON、重复键拒绝、原始容量限制、真实ReadableStream读取和Abort/close。见[A3执行记录](ZT12-01-A3-execution.md)。独立本机HTTP测试不替代真实供应商/授权/持久边界；父完整关闭条件不变，最终精确验收和合并以关联PR为准。
