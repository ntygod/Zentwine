# ZT07｜全链路变更驾驶舱

状态：Planned。负责人职责：后端、产品、前端、执行与质量。依赖模块：ZT06、ZT09、ZT11、ZT16、ZT19。事件/Adoption 契约前置冻结，完整联调在依赖模块可用后完成。对应蓝图：05.4、14.3。

## 目标

需求、设计或契约变化后，找到受影响对象并落实调整，不止更新文档或群发消息。影响结论分确定、可能、未知、不受影响且有依据。批准新版本、消息送达、运行时接收、实际采用和重验证分别记录。

## 数据与流程

ChangeRequest(base,target,reason,owner)、ImpactEdge(object,revision,evidence,confidence_kind)、Disposition(continue/checkpoint/restart/rework/waive)、AdoptionReceipt(delivered,received,adopted,verified)、StaleEvidence。

proposed → analyzing → awaiting_approval → approved → propagating → verified → closed。未完成必需项不能显示 100%。已完成产物可记录兼容性或重验证；未知依赖必须可见。

API `/changes`、`/changes/{id}/analyze`、`/impact-items/{id}/decide`、`/adoptions/{id}/ack`；重要事件 change.approved、context.adoption_required、evidence.stale。

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT07-01 | ZT06-03 | 实现变更对象、结构化差异和关系遍历；固定审批的目标版本 | 基线改变返回冲突；旧申请不能覆盖更新版本 |
| ZT07-02 | ZT07-01 | 接入设计/接口/代码/执行/证据关系，生成影响图与未知覆盖范围 | 未索引仓库显示未知；AI 推断不伪装确定依赖 |
| ZT07-03 | ZT07-02、ZT02-04 | 实现逐项处置、审批、范围/日期/权限变更升级 | 不受影响决定有依据；批量批准不隐藏不同资源范围 |
| ZT07-04 | ZT07-03、ZT16-04 | 实现定向传播和幂等采用回执，处理检查点更新和新 Run 接替 | 收到消息不自动变 adopted；不支持 steer 时走明确停止/新执行 |
| ZT07-05 | ZT07-04、ZT19-04 | 实现旧证据失效、重核队列、传播 UI 与开发工作区提示 | 旧提交测试不能满足新验收；合计与各项状态一致 |
| ZT07-06 | ZT07-05 | 建立邀请 7 天→24 小时的跨端/跨模型回归和故障恢复 | 断线、重复通知、完成中变更、人工异议均不会丢失或伪完成 |

## 完成与风险

同一变更必须覆盖设计、接口、任务、执行、代码、测试和发布关系中的已知相关对象；未知明确列出。采用证据绑定新上下文摘要。消息反复失败进入待处理队列，不无限催问。关闭高级分析时仍能人工指定影响项完成受控流程。
