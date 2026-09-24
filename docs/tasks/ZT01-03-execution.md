# ZT01-03 执行记录

任务：[工程底座](../modules/01-foundation.md)。前置 ZT01-02 已合并；输入 main@bd5610e6d14f6e58a0f85814bca1f6e89aaf8ef7，源码树 10c4e613172433dcbda1d37aceb4730cc2955fd4。[Issue #6](https://github.com/ntygod/Zentwine/issues/6)；[PR #7](https://github.com/ntygod/Zentwine/pull/7)；分支 feat/ZT01-03-safe-foundations。

状态：Done（限定实现验收已有证据，最终合并只在最新精确提交的必要检查全部通过后执行）。实施与技术决定：获授权的 AI 开发会话，不冒称独立人工评审。合并状态和最终 SHA 以 PR 为准。

## 已交付

配置与条件必需依赖解析、安全错误目录及框架映射、请求追踪与受控传播、真实/固定时间和 ID、有界脱敏与结构化诊断日志。接入现有本地 API，不启用生产、不增加业务端点、不创建执行或调用模型。

日志过滤运行时非法级别；16 KiB 限制包括 UTF-8 字节和换行。公共接口不采用外部 trace 标识；时间回拨不改变单调耗时。业务权限默认拒绝保持不变。

## 已验证

首轮功能 head `7c0c43cf90ff7701a90b4c37bb5185f32a429395`，实际 PR 合并测试提交 `14319f09461f2edebfba27413b739e58c0f31633`，源码树 `b14d687481b763f27b950c7689bd20ff65535379`。

[工程 CI 35983819355](https://github.com/ntygod/Zentwine/actions/runs/35983819355) 在 Node 24.21.0 / pnpm 11.10.0 的干净 Linux 环境通过冻结安装、格式、边界、构建、类型、67 个核心/API 测试和 7 个真实浏览器场景。无 skip；端口 4100/5173/5174 均释放，构建测试后源码未变化。当次依赖审计未报告漏洞，不代表永久安全保证。

[文档 CI 35983819438](https://github.com/ntygod/Zentwine/actions/runs/35983819438) 通过。下载 artifact 10801371912 的 SHA-256 为 `f5c8ad66194d945f9a3b7d73733c8a94a1a62120cce082f5e3c83cba80af34a4`，其中源码逐文件与本地工作树一致；锁文件哈希匹配。更早的本地 49 个基础测试运行于 Node 22，仅是辅助检查，不替代 Node 24 CI。

后续文档/测试入口整理和持久流程回归触发路径扩展，仍须通过本 PR 最新 Checks；不能用本轮成功替代新提交测试。既有 Spike 与断言未改，仅将 domain/telemetry 改动加入回归路径。详细边界见 [报告](../testing/zt01-03-report.md)。

## 工具与安全记录

临时只读工具导出仅获取既有固定 Prettier/TypeScript。另一个数据作业读取固定 SHA 锁文件，仅加入固定 workspace link，验证前后 Git blob SHA 后创建未引用 blob；不 checkout/执行仓库代码、不创建提交、不更新分支。两项临时工作流不在最终树。常规 CI 继续只读、冻结安装、检查源码不变。

## 非目标

数据库连接、租户授权、FakeRuntime、完整 OTel、诊断日志持久化/背压、真实 Claude/Codex、生产发布均未实现。SecretValue 不是加密；脱敏不能识别任意编码或未知秘密。Zentwine 完整 E01–E52 不因基础测试通过而通过。

## 使用与后续

先 `pnpm build`，再 `pnpm test:foundation` 运行本任务 37 个针对性测试；`pnpm check` 保留总计 67 个测试。使用说明见 [安全基础](../development/safe-foundations.md)，决定见 [ADR-007](../adr/ADR-007-safe-foundations.md)。下一工作包 ZT01-04：FakeRuntime、租户 Fixture、临时数据库和隔离测试，不在本 PR 提前宣称完成。
