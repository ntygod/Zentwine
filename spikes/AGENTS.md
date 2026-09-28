# 隔离技术实验

## 适用范围

继承 [根约定](../AGENTS.md)。实验与产品实现分开：持久流程实验的结果不代表产品已有编排服务。

沿用子实验自己的 README、package/lock 和固定工具链，不将主工程安装命令直接套入实验。先说明假设、通过/失败条件及隔离资源，再执行真实故障恢复。

引用 [ADR 索引](../docs/adr/README.md) 和 [故障环境指南](../docs/development/local-environment.md)；采用结论需要记录限制与回退，不能只更新提示词。

验证使用该实验固定的 unit/integration 命令及已有 durability CI。保留故障和失败历史，不将 Fake 替换真实 Temporal/PostgreSQL 结果；清理自己创建的服务，不部署生产。
