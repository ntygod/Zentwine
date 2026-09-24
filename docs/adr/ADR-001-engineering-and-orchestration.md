# ADR-001｜工程基线与持久工作流

状态：**Accepted（工程与持久流程方向）**。决定日期：2026-09-24。关联 ZT01-01 / Issue #2 / PR #3。

决定者：根据项目负责人在项目对话中授予的完整决策权，由本次 AI 实施者作技术决定并留痕；不是额外独立人员审核。

## 决定

采用 TypeScript pnpm monorepo、模块化 Node 控制面、PostgreSQL 业务权威库、独立 Runner 与 Verifier。Temporal 作为持久流程引擎，通过 WorkflowPort 隔离，不把其状态当作业务授权。

React / Vite 提供 Workbench 和 Studio；Fastify 提供 API。精确工程版本见 [版本与开发说明](../development/foundation.md)。前端不得直接接触供应商凭据或原始 App Server。

## 证据

PR #3 的分支 `09297979ab7d2a8a57f0d52027259aa173eff657`，PR 测试提交 `4ccb1cf0052287be4290c4b1ef6ae8402c2f4ef0`，故障测试运行 `35977114973`。8 个单元测试、9 个真实 PostgreSQL/Temporal 场景通过，包括等待、SIGKILL、持久化重启、重复请求、提交后崩溃、拒绝与回放。PR #3 已合并为 `a74d81b2bd82b9fc4c6a813ef823236260689c02`。

实验使用 Temporal 开发服务器 SQLite 历史和 PostgreSQL 业务数据，不是生产 Temporal/PostgreSQL 集群证明。详见 [实验报告](../testing/zt01-01-report.md) 和 [实验说明](../../spikes/ZT01-01-durable-workflow/README.md)。

## 取舍与备选

接受持久引擎带来的额外运维、历史兼容和部署成本，以避免自行实现全部等待、恢复和回放。PostgreSQL 状态机+队列保留为 WorkflowPort 的替换方案；没有实测比较的性能和成本不下结论。单模型长会话与浏览器内存不作为业务权威。

业务改变与 outbox 同事务，重复外部请求以稳定 operation/workflow ID 对账；不宣称任意外部动作 exactly-once。域模型、审批、预算独立于 SDK。

## 不包含的批准

生产存储、加密、备份、部署拓扑、性能目标、供应商商用与产品发行许可须各自落地决策和验证。本决定不允许提前部署无身份服务，不自动调用付费模型。

## 回退

当前 Spike 隔离在 spikes/；主工程不引用其实验授权逻辑。若企业环境或运维证据否定 Temporal，保留业务契约替换 WorkflowPort，记录新 ADR；不能削弱授权与幂等语义。

## 官方资料

- [Node 支持周期](https://nodejs.org/en/about/previous-releases)
- [Temporal SDK 1.24.0](https://github.com/temporalio/sdk-typescript/releases/tag/v1.24.0)
- [Temporal 测试](https://docs.temporal.io/develop/typescript/best-practices/testing-suite)
- [PostgreSQL 支持政策](https://www.postgresql.org/support/versioning/)
