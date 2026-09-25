# ZT02-04｜版本绑定审批执行记录

输入main@570c9297369eb5ddf1e0caa9093ff76236ee47a4，Issue #21。状态InReview，尚待最终精确CI。

## 交付

- immutable binding与content_hash；独立人工批准和政策预授权有不同来源。
- 短期一次性许可，锁后重查，消费/目录改名/回执/事件同事务。
- 当前身份过滤的持久游标通知，身份/组织/成员/策略治理事务内撤销。
- 0004迁移、HTTP/绑定工具、最小权限命令；Agent不能借人类许可提权。
- 规则/API测试与真实PG/TCP/并发/故障验证；保留旧测试、锁文件和必要CI。

实现见packages/policy/src/approvals.ts、packages/db/src/approvals.ts、services/api/src/approvals。理由与边界见[ADR-014](../adr/ADR-014-bound-approvals.md)，使用见[指南](../development/bound-approvals.md)。

按既有授权实施和自审，不冒称第三方独立安全审核。不调用真实模型、不部署生产、不修改平台分支保护。
