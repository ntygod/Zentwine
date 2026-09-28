# 数据库适配层

## 适用范围

继承 [共享包约定](../AGENTS.md)。先读 [租户 repository](../../docs/development/tenant-repository.md) 和本次业务指南，不加载所有身份历史。

## 不变量

运行与迁移身份分离；强制 RLS、精确租户关联与锁后鉴权不能因方便调试而绕过。失败、取消、撤权和返回结果不一致必须使外层事务回滚。

迁移采用新增编号的 up/down/verify 与 manifest；已合并迁移、摘要和已发布快照不原地重写。验证回退限制，不把 destructive rollback 当普通恢复。

[版本持久化阻断](../../docs/tasks/status.md) 仍独立跟踪。纯版本规则/合成 SQL 响应不是数据库 CAS 验收；不要在整理文档时合并被阻断的迁移。

## 验证

`pnpm migration-check` 后，在专用临时库执行 `pnpm test:migrations`、`pnpm test:tenant-integration` 和受影响业务集成。真实业务库禁止用作测试。覆盖跨租户、竞争、过期/撤权、权限误授与回滚；配置缺失应失败，不跳过。

环境及完整命令见 [验证路由](../../docs/harness/verification.md)；变更 [迁移检查器](../../scripts/quality/migrations.mjs) 是独立安全敏感工作，不是绕过失败的快捷方式。
