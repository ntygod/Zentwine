# 09｜决策、风险与资料依据

## 1. 依据与优先级

基线文件：《团队研发操作系统_终态产品蓝图_v2.0.md》，本次读取的 SHA-256：`b9a4c0947e0a11ef3f8fbce6b9e295cf4773224d68036740b9d99eca6d1daf25`。原文件是项目附件；本仓库通过范围追踪文档保存完整能力映射，未把历史 UI 中的演示数据视为产品事实。

补充决定来自当前对话：品牌 Zentwine/众弦；独立 Coding 工作台是完整产品入口；管理和 Coding 共用工作对象但布局可独立；支持 Claude/Codex 基座上的真正异构模型协作。用户未批准具体框架、供应商合同、许可证、预算或上线日期。

优先级：后续明确批准决定 > 本实施契约 > 终态能力蓝图 > 历史视觉概念。出现冲突需记录决策，不静默取舍。

## 2. 待批准事项

| ID | 决策 | 默认提案 | 通过证据 / 负责人职责 |
|---|---|---|---|
| D01 | 工程与流程引擎 | TS monorepo + PostgreSQL + Temporal | 版本、许可证、最小故障恢复 POC / 技术负责人 |
| D02 | Studio 编辑器与桌面 | React/Monaco + Electron 候选 | IME、大文件、LSP、预览隔离与签名更新 / 前端与安全 |
| D03 | 不可信执行隔离 | 专属环境先验证，跨租户强隔离 | 租约失联、逃逸面、出口、凭据与资源测试 / 平台安全 |
| D04 | 供应商授权和品牌 | 官方 API 身份；独立 Zentwine 品牌 | 对目标部署核对商用、数据、模型可用性 / 负责人 |
| D05 | 原生仓库基础设施 | 可替换 Git 托管端口 | 数据导入导出、LFS、hooks、权限与运维成本 / 平台 |
| D06 | 产品开源和付费条款 | 不擅自选择许可证或定价 | 负责人正式决定及依赖许可清单 |

## 3. 主要风险及应对

供应商接口变化：能力报告、版本锁定、契约回归、允许新 Run 接替；不能永久承诺某版本功能。

项目过大：按同一架构分波次验收，不删终态能力，不把全部模块并行扔给 Agent。

模型协作成本失控：预算预留、并发/轮次限制、真实对照评估；没有收益时允许单模型。

共享状态不一致：批准版本、事件顺序、乐观锁、显式权威来源和恢复对账。

安全与验证自证：执行/验证分离、文件和工具边界、对危险默认的专项检查。

推演和归因过度确定：保留假设、数据不足与人工判断，不把模型分数或摘要包装成客观事实。

## 4. 核对到的外部事实（2026-09-24）

Claude Agent SDK 官方文档提供可嵌入循环、工具、会话及权限；并说明第三方产品未经批准不能提供 claude.ai 登录/额度，需采用文档认证方式。品牌指引建议 UI 使用 Claude Agent 等名称，不冒充 Claude Code。[S01]

Codex SDK 的官方定位覆盖程序化集成；自定义客户端深度交互使用 App Server 资料。当前文档仍对 App Server 命令和 WebSocket 传输提示实验性及生产限制，并指出部分 shell/process 接口不继承线程沙箱；适配计划必须逐项核对，而不是直接开放所有方法。[S02][S03]

以上只决定实施核验项，不缩减终态多基座目标。尚未运行本项目真实适配测试，所有兼容结论初始为 unverified。

## 5. 官方资料索引

- [S01] Claude Agent SDK overview：<https://code.claude.com/docs/en/agent-sdk/overview>
- [S02] Codex SDK：<https://developers.openai.com/codex/sdk/>（本次跳转至 learn.chatgpt.com 官方文档）
- [S03] Codex App Server：<https://developers.openai.com/codex/app-server/>
- [S04] Temporal TypeScript：<https://docs.temporal.io/develop/typescript>
- [S05] PostgreSQL Row Security：<https://www.postgresql.org/docs/current/ddl-rowsecurity.html>
- [S06] Git worktree：<https://git-scm.com/docs/git-worktree>
- [S07] MCP Security Best Practices：<https://modelcontextprotocol.io/specification/latest/basic/security_best_practices>
- [S08] GitHub Webhook Best Practices：<https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks>

来源用于具体技术事实；本文绝大部分模块、字段、任务和阈值是本项目设计提案。开发前按采用的精确版本复查，保存 checked_at、版本与实验记录，不把 URL 的 latest 当锁版本。
