# Infrastructure

当前主工程无需数据库、Docker 或模型账户即可启动 bootstrap。真实 PostgreSQL/Temporal 实验环境见 spikes/ZT01-01-durable-workflow。生产部署、备份与隔离基线属于 ZT27，尚未完成。

ZT01-06本机可销毁基础设施见 `development/compose.yml`，由 `pnpm env:up/status/down` 管理；不要直接把它部署公网。使用说明：[统一本地环境](../docs/development/local-environment.md)。
