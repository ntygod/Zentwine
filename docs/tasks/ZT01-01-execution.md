# ZT01-01 执行记录

任务来源：[工程底座](../modules/01-foundation.md)。输入基线：main@0f9db94bb57ea015845cdd10c17d9c73737ca908。工作分支：`spike/ZT01-01-durable-workflow`。

状态：**InReview**；架构决定：**NeedsDecision / ADR Proposed**。实施：本次 AI 开发会话；评审/最终批准：仓库负责人。关联 [Issue #2](https://github.com/ntygod/Zentwine/issues/2) 和 [PR #3](https://github.com/ntygod/Zentwine/pull/3)。

## 已交付

隔离的真实 Temporal/PostgreSQL 技术实验、ADR-001 提案、版本与许可资料、依赖锁、只读测试 CI、运行与清理说明。8 个单元测试和 9 个集成场景已有通过记录，含 Worker SIGKILL、服务器重启、提交后崩溃重试与真实历史回放。

验证入口：[实验 README](../../spikes/ZT01-01-durable-workflow/README.md)。精确证据、失败迭代、环境和未测边界见 [验证报告](../testing/zt01-01-report.md)。最新提交仍须以 PR Checks 为准，不把前一次成功自动转移给变更后的代码。

## 未完成或未批准

没有跳过 ZT01-01 宣布 ZT01-02 工程骨架或 Studio 功能完成。ADR-001 尚未由负责人批准，因此没有把任务或模块改为 Done。产品验收 E01–E52 全部仍不是本实验的通过声明。真实 Claude/Codex、租户安全、生产服务、长期容量与高可用未执行。

## 下一步

依据实验结果评审 ADR-001；批准工程基线后执行 ZT01-02，再建立 config/错误/追踪、测试框架和 CI（ZT01-03～06）。主工程 pnpm workspace 与本目录的隔离 npm 实验区分；实验中的简化身份、审批和取消处理不得直接成为生产实现。
