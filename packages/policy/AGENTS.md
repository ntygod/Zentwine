# 授权规则

## 适用范围

继承 [共享包约定](../AGENTS.md)，只依赖 domain。先读 [授权策略](../../docs/development/authorization-policy.md)，涉及委派/审批时再打开对应指南。

默认拒绝；权限绑定可信身份、租户、资源及精确动作。Agent 权限只收窄、不放大委派链；审批绑定版本与动作，批准者/作者职责分离。UI 显示、能力声明和内容摘要都不是授权依据。

纯策略不得自行连接数据库、网络或读取进程环境。持久撤权、锁后复验与事务保证交给现有端口和 API/db 实现；不要在纯测试里宣称这些已发生。

运行 `pnpm test:policy`、`pnpm check`；委派/审批改动增加对应纯规则测试，再验证真实 PG/HTTP/WS 消费方。关键拒绝原因和审计字段不得携带敏感正文。

参考 [Agent 委派](../../docs/development/agent-delegations.md)、[绑定审批](../../docs/development/bound-approvals.md)、[权限矩阵](../../docs/development/access-matrix.md)。
