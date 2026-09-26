# ADR-022｜授权目录对象页与最小布局偏好

状态：Accepted（A限定实现验收通过）；最终文档提交复验与合并见PR #41。对应ZT04-03 / Issue #40。前置ZT04-02已交付；0009及完整对象版本流尚阻断。

## 决策

复用现有资源GET和Workbench请求生命周期，不建立第二套客户端身份或新的未经验证权限端点。仅暴露严格匹配组织/对象/版本的目录快照，服务端仍逐次检查。UI框架分正式记录、协作对话与侧栏，读取判定与人类批准明确分开；对未实现通道展示不可用，而非虚构记录。此增量不冒充完整ZT04-03。

布局偏好是用户明确保存的固定枚举，无租户标识或内容。client处理Storage边界，UI hook管理偏好状态，Workbench只依赖UI与contracts；不放宽包依赖规则。存储拒绝或数据坏损不阻断对象读取，无法清除时不宣称已删除。

抽屉使用原生dialog/showModal，关闭按钮初始焦点、Escape关闭、正常关闭返回原触发点；受保护树卸载后不将焦点放回已移除对象。样式采用共享语义tokens，支持forced-colors，不加载外部UI资产。

参考：W3C模态对话实践 https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/dialog/ ；HTML dialog文档 https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog 。示例不是本产品独立可访问性认证，实际验收以项目浏览器测试为准。

## 取舍与回退

本轮不把现有授权审批误接成内容批准，也不复制未验证版本草稿。代价是侧栏部分能力仍不可用，须在B中接入真实后端并追加权限/过期/冲突回归。没有正文缓存、实时流、Run、Service/Agent新适配或公开写接口。

需要回退时移除资源深链分派/目录详情链接及新增组件，原目录API与身份不受影响；仅浏览器布局key可单独清除，不需迁移数据库。恢复旧页面不影响已记录的服务端授权事实。
