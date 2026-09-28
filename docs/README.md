# Zentwine 文档入口

按问题取最少需要的上下文；先看现状，再看对应指南，只有涉及范围或设计取舍时才打开终态规划。

| 你要解决的问题 | 去哪里 | 何时再深入 |
|---|---|---|
| 当前做到了哪里、什么还阻塞 | [实施状态](tasks/status.md) | 对应 Issue/PR 与执行记录 |
| 从新机器开始开发 | [贡献指南](../CONTRIBUTING.md) | [开发环境](development/local-environment.md) |
| 让 Agent 修改某个目录 | [根 AGENTS](../AGENTS.md) | 路由输出的祖先指南；[Harness](harness/README.md) |
| 使用/修改一个已有能力 | [开发指南索引](development/README.md) | 该能力契约、代码与测试 |
| 理解为什么这样设计 | [ADR 索引](adr/README.md) | 对应方案与兼容/回退 |
| 找一个工作包的实施记录 | [任务索引](tasks/README.md) | 精确 head 与真实 CI |
| 核对验证范围与结果 | [验证路由](harness/verification.md)、[报告索引](testing/README.md) | 真实环境/失败历史/制品 |
| 看长远目标和模块依赖 | [终态规划索引](plans/README.md) | 仅选相关模块，非当前功能清单 |
| 维护分支和文档结构 | [维护索引](maintenance/README.md) | dry-run 清单、限制和回退 |

## 文档归属

`development/` 写操作方法，`adr/` 写决定，`tasks/` 写实施与当前状态，`testing/` 写证据，`plans/` 与 `modules/` 写终态目标；历史材料按日期归档而不是混进当前指引。

[设计期契约](contracts/README.md) 不等于供应商 SDK 或当前实现；[E01–E52](tests/end-to-end.md) 不等于已执行的端到端测试。模板按需使用：[任务](templates/work-item.md)、[PR](templates/pull-request.md)、[ADR](templates/adr.md)。
