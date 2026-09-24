# ZT01-03 验证报告

日期：2026-09-24。结果针对明确代码版本，不代表生产认证或完整产品验收。

## 固定证据基线

功能 head：`7c0c43cf90ff7701a90b4c37bb5185f32a429395`。PR 测试提交：`14319f09461f2edebfba27413b739e58c0f31633`。源码树：`b14d687481b763f27b950c7689bd20ff65535379`。

工程运行：[35983819355](https://github.com/ntygod/Zentwine/actions/runs/35983819355)。文档运行：[35983819438](https://github.com/ntygod/Zentwine/actions/runs/35983819438)。最终合并复验另见 [PR #7 Checks](https://github.com/ntygod/Zentwine/pull/7/checks)，新增提交不得继承旧通过状态。

| 验证层 | 数量/检查 | 首轮实际结果 |
|---|---|---|
| 既有核心/API | 30 | 通过，原断言保留 |
| 配置、错误、trace、时钟和脱敏 | 27 | 通过 |
| 运行时日志级别与 UTF-8 字节边界 | 2 | 通过 |
| API 接入与启动进程 | 8 | 通过 |
| Chromium 双工作台回归 | 7 | 通过 |
| 冻结依赖、格式、架构边界、构建、类型 | 全部当前包 | 通过 |
| 进程清理 | 4100、5173、5174 | 全部可重新监听 |
| 当次依赖审计 | 123 个依赖项报告 | 未报告漏洞 |
| 源码不变 | git diff --exit-code | 通过 |

50 路异步上下文隔离在基础测试中验证；40 路并发 API 测试使用真正 Fastify 生命周期与 inject，不冒称并发 TCP 负载测试。浏览器场景实际启动构建后的前端及本地 API，以真实网络请求执行导航/错误/恢复验证。配置失败测试真正启动 API 子进程并验证绑定前退出。

合成测试覆盖凭据不进入错误及 HTTP 日志、body 限额与413/415、未知错误和异常链、getter/toJSON、循环/深度/大小、原型字段、非法日志级别、sink 失败、父子 span 和绑定回调、外部 trace 丢弃、系统时间回拨。

## 制品核验

artifact `10801371912`：`f5c8ad66194d945f9a3b7d73733c8a94a1a62120cce082f5e3c83cba80af34a4`（SHA-256）。本次沿用既有 CI 制品名 zt01-02-foundation-evidence，以 run/head/tested-commit 识别版本，不按文件名称猜任务。

`pnpm-lock.yaml`：`d19afc5da12074ee3ad4af0fb3ac3fa6837bb7b85c79e22af5765165111abcca`。只有 telemetry→domain 的 workspace link 变更，无外部版本升级。已核对日志、源码、锁文件与输出环境版本。

## 持久工作流回归

首轮没有修改 Spike 或原触发路径，因此路径过滤未运行持久故障实验；不将旧运行当作新提交证据。收尾提交扩展了该检查的 domain/telemetry 触发路径，断言、实现和权限均未放宽。最终结果由 PR 最新 Checks 和交付说明记录。

## 限制与复现

仅 Linux/Node 24 基线完整验证；本地 Node 22 的49项基础测试只是辅助。没有生产、真实模型、真实客户数据、数据库新功能、完整身份或审计账本。正则脱敏不是万能秘密识别，SecretValue 不是加密，ALS 不是跨进程运输，W3C 接续只覆盖 v00 子集。

复现：`pnpm install --frozen-lockfile` → `pnpm check` → `pnpm exec playwright install --with-deps chromium` → `pnpm test:e2e`。针对本任务：构建后 `pnpm test:foundation`。完整任务边界见 [执行记录](../tasks/ZT01-03-execution.md)。
