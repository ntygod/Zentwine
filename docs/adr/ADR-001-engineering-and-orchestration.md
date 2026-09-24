# ADR-001｜工程基线与持久工作流候选

状态：**Proposed**。日期：2026-09-24。关联任务：ZT01-01；Issue #2。负责人审批：待仓库负责人。技术实验可以执行，生产选型不由实现者自行改为 Accepted。

## 背景

Zentwine 要支持跨模型执行、人工等待、进程失败、重复消息和代码/业务状态分离。长时间运行一个模型会话或用浏览器内存维护计划，不能作为正式持久状态设计。

## 提议

继续采用规划中的 TypeScript 主工程、模块化 Node 控制面、PostgreSQL 业务权威库、独立 Runner/Verifier；Temporal 作为可替换的持久流程候选。主工程 pnpm workspace、React/Fastify 等包选择在 ZT01-02 固定，不在本 Spike 混入产品代码。

Temporal 保存调度历史，不批准业务行为。工作流收到信号后由 Activity 再读取业务决定；数据库命令保留幂等指纹、事务 outbox。重复启动按稳定 workflowId 对账，不能在结果未知时换 ID 再启动。

## 备选与取舍

| 方案 | 取舍 | 当前决定 |
|---|---|---|
| Temporal + PostgreSQL | 引擎提供等待/历史/重试，需维护额外服务、历史兼容与部署能力 | 候选，先以故障实验取证 |
| 自建 PostgreSQL 状态机 + 队列 | 部署组件较少，但需自己实现计时、等待、租约、重放、恢复等 | 保留退路，不凭没有实测就宣称性能更差 |
| 托管专有流程服务 | 可以减少自运维，但企业私有部署、供应商耦合需进一步评估 | 暂不默认采用 |
| 单 Agent 长会话 + 内存任务表 | 原型简单，但不能提供本计划要求的持久恢复边界 | 不作为权威控制面 |

## 验证实现

见 [Spike 说明与代码](../../spikes/ZT01-01-durable-workflow/README.md)。实现真正 PostgreSQL 事务、Temporal 开发服务器、独立 Worker SIGKILL、服务器重启、重复请求、丢失启动应答、历史回放、拒绝和取消。实验不连接真实模型。

实验实现与选择独立：CI 成功仅支持所测试的故障语义，不证明高可用、性能、成本、生产安全或所有模型兼容。业务数据库 PostgreSQL 与 Temporal 开发服务器 SQLite 是两个不同存储，绝不把 SQLite 试验等同生产 Temporal/PostgreSQL 部署。

## 批准前需要决定

1. 是否接受新增持久引擎的运维负担，并按 WorkflowPort 隔离供应商实现。
2. 生产 Temporal 存储、备份恢复、历史保留、加密、集群升级和私有部署条件。
3. 代表性负载、吞吐和费用预算；本试验没有得出成本优劣结论。
4. 工程依赖许可与产品许可证。技术清单不是法律意见，也未替仓库选择开源许可证。

批准时记录负责人、日期和所依据的精确 CI commit。若实验无法稳定恢复、实际运维成本不适合或企业环境无法部署，拒绝该候选，使用保留的 WorkflowPort 实现替代方案，而不是修改业务语义以迎合引擎。

## 回退

本 PR 仅增加隔离 Spike、提案、执行记录与测试工作流，没有生产迁移或外部业务写入。可回退该提交并关闭试验；保留历史测试作为决策证据。未来主工程不应直接导入 Spike 内的简化身份和授权代码。

## 官方依据（核对日期：2026-09-24）

- [Node 发布支持状态](https://nodejs.org/en/about/previous-releases)：选择受支持 LTS，不把 Node Current 自动当成生产基线。
- [Temporal TypeScript SDK 1.24.0](https://github.com/temporalio/sdk-typescript/releases/tag/v1.24.0)：本试验锁定 SDK 系列。
- [Temporal 测试与历史回放](https://docs.temporal.io/develop/typescript/best-practices/testing-suite)：区分 Mock、集成与真实服务验证。
- [TestWorkflowEnvironment](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment)：createLocal 支持指定 CLI、持久化开发数据库与外部 Worker 连接。
- [PostgreSQL 支持版本](https://www.postgresql.org/support/versioning/)：17.11 属于本次核对的受支持系列补丁。
- [node-postgres 事务](https://node-postgres.com/features/transactions)：同一事务使用同一个 client。
