# ZT01-02 执行记录

状态：**Done（限定工程骨架已实现并通过验证）**。关联 [Issue #4](https://github.com/ntygod/Zentwine/issues/4)、[PR #5](https://github.com/ntygod/Zentwine/pull/5)。分支 `feat/ZT01-02-engineering-foundation`，输入 main@a74d81b2bd82b9fc4c6a813ef823236260689c02。

依据：工程底座计划、公共架构/状态/接口计划、独立 Studio 补充约定，以及负责人授予的决策与开发权。通过精确提交的验证后由受托实施者合并，合并状态以 PR 为准。

## 已实现

- 固定 pnpm/TypeScript 主工程，10 个当前实际构建包；根项目共 11 个 workspace projects。
- 两个 React 构建：Workbench 与独立 Studio；Fastify 本机只读 API。
- contracts/client/config/telemetry/domain/testkit/ui 的最小支撑和显式包依赖检查。
- 核心/API/真实浏览器测试；只读新窗口、未知资源、错误与重连路径。
- 开发启动、进程清理、环境诊断、运行文档、固定依赖及只读 CI。

## 冻结提交复验

分支提交 `3e990c22c3d74837be4d1fb1fe6554992f503109`，实际 PR 合并测试提交 `b71ddf428561c08eb0516c7b7874021d025d9dab`。

[CI 35980200109](https://github.com/ntygod/Zentwine/actions/runs/35980200109) 在干净环境按已提交锁安装，不重写源文件。构建、类型、lint/依赖边界、30 个核心/API 测试、7 个真实浏览器场景、格式检查、环境诊断、安装依赖后的文档检查均通过；4100/5173/5174 端口全部释放，git diff 为空。当次依赖审计无已报告告警。结果不是永久安全证明。

后续仅有本组状态/验证文档更新；其精确提交仍由 PR CI 复验。完整来源、哈希和失败修复记录见 [报告](../testing/zt01-02-report.md)。

## 未实现范围

没有真实模型、编辑器、租户身份、授权引擎、持久业务工作区、双模型协作或生产部署。未把 ZT01-03/04/05/06 或 ZT17 整体标为完成。Linux CI 已验证，其他操作系统不作未经测试的承诺。

## 回退与继续建设

可回退本轮 PR；无生产迁移、无云资源创建、无收费模型调用。下一工作包为 ZT01-03：完善配置、结构化错误、trace、时间/ID 服务与脱敏；随后补齐正式测试与工程门禁，再进入身份与版本化业务数据。完整终态范围不缩减。
