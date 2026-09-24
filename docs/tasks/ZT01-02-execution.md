# ZT01-02 执行记录

状态：InProgress。Issue #4。分支 feat/ZT01-02-engineering-foundation。输入 main@a74d81b2bd82b9fc4c6a813ef823236260689c02。

依据：工程底座计划、公共架构/状态/接口计划、独立 Studio 补充约定，以及负责人授予的决策与开发权。实施者自行记录 ADR、核验 CI 并决定合并，不再等待普通选型确认。

## 实现范围

- 固定 pnpm/TypeScript 主工程，10 个当前实际构建包。
- Workbench 与 Studio 两个 React 构建，Fastify 本地只读 API。
- contracts/client/config/telemetry/domain/testkit/ui 的最小支撑和显式依赖检查。
- 核心/API/真实浏览器测试，故障状态、深链、只读导航和错误处理。
- 开发启动/清理、文档和 CI 证据。

## 不在完成声明中

没有真实模型、编辑器、租户身份、授权引擎、持久业务工作区、双模型协作、部署。未把 ZT01-03/04/05/06 或 ZT17 整体标 Done。生产 Temporal 部署继续单独设计。

## 验证

结果以本分支最终精确提交和 Actions 证据为准；尚未运行的测试不记通过。CI 运行 lint/边界检查、构建、类型、单元与 API、Playwright 浏览器和依赖审计。现有文档与 Spike 检查保留。

## 回退

回退本轮 PR 即可；无生产迁移、无云资源创建、无付费调用。
