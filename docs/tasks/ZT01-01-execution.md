# ZT01-01 执行记录

任务来源：[工程底座](../modules/01-foundation.md)。输入基线：main@0f9db94bb57ea015845cdd10c17d9c73737ca908。工作分支：`spike/ZT01-01-durable-workflow`。

当前状态：**Done**；架构决定：**ADR-001 Accepted（工程与持久流程方向）**。关联 [Issue #2](https://github.com/ntygod/Zentwine/issues/2) 和 [PR #3](https://github.com/ntygod/Zentwine/pull/3)。

## 决定与合并

最初交付状态为 InReview / NeedsDecision。项目负责人随后明确授权全部项目决策与向下开发，本次 AI 实施者核对现有故障测试后接受工程方向并合并 PR #3。合并提交为 `a74d81b2bd82b9fc4c6a813ef823236260689c02`；该记录不是伪称另一位独立人员审批。

## 已交付

隔离的真实 Temporal/PostgreSQL 技术实验、ADR-001、版本与许可资料、依赖锁、只读测试 CI、运行与清理说明。8 个单元测试和 9 个集成场景已有通过记录，含 Worker SIGKILL、服务器重启、提交后崩溃重试与真实历史回放。

验证入口：[实验 README](../../spikes/ZT01-01-durable-workflow/README.md)。精确证据、失败迭代、环境和未测边界见 [验证报告](../testing/zt01-01-report.md)。后续变更仍须以其精确提交的 CI 为准，不把旧结果直接迁移。

## 不包含的结论

产品验收 E01–E52 不属于本实验通过声明。真实 Claude/Codex、租户安全、生产服务、长期容量与高可用未执行。实验中的简化身份、审批和取消处理不能直接成为生产实现。

## 衔接

工程基线已经用于 [ZT01-02](ZT01-02-execution.md)。主工程使用 pnpm，隔离实验保留自己的 npm 锁；代码不能反向引用实验逻辑作为业务授权。后续继续建设 config/错误/追踪、测试框架与完整工程门禁。
