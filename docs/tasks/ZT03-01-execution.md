# ZT03-01｜租户 repository 与数据库隔离执行记录

基线：main `520e4d21935aad8f82fd8a47123e80183abdd04f`；Issue #30。前置ZT02-01已验收，本工作包不需要将尚无业务实现的ZT02-06完整通道待办虚假关闭。

状态：InProgress。已实现候选代码、迁移、角色授权入口和真实数据库测试，待目标环境完整CI及精确制品核验。

## 交付

0008引入对象标识/关联的独立租户schema、强制RLS、复合主/外键和私有事务上下文；类型化repository只暴露固定参数化操作。使用数据库会话验证而非任意org/GUC，支持租户隔离的批量和关联读取；运行身份不能修改结构、私有绑定、旧身份凭据或登记历史。旧控制面和UI不重写。

复用当前manifest、摘要、ledger和逆序迁移机制；新增tenant:admin受控本机授权入口。受控测试中的独立NOLOGIN owner安装，与低权tenant登录pool分离。缺上下文、伪造、撤销/到期、跨租户写入、连接复用、角色越权、错误回滚及迁移回退有新测试。

关联指南：[开发说明](../development/tenant-repository.md)、[ADR-017](../adr/ADR-017-tenant-data-access.md)、[验收记录](../testing/zt03-01-report.md)。不在此轮实现版本/CAS、语义关系、事件总线或未来HTTP路径。
