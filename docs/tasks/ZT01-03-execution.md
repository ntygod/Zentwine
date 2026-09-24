# ZT01-03 执行记录

任务：[工程底座](../modules/01-foundation.md)。前置 ZT01-02 已合并；输入 main@bd5610e6d14f6e58a0f85814bca1f6e89aaf8ef7，源码树 10c4e613172433dcbda1d37aceb4730cc2955fd4。Issue #6；分支 feat/ZT01-03-safe-foundations。

状态：InProgress。实施与技术决策：本次获授权 AI 开发会话；不冒称独立人工评审。

## 交付范围

配置与条件必需依赖解析、安全错误目录及框架映射、请求追踪与受控传播、真实/固定时间和 ID、有界脱敏与结构化诊断日志。接入现有本地 API，不启用生产、不增加业务端点、不创建运行或调用模型。

## 验证状态

在隔离本地环境使用固定 TypeScript 编译相关基础包，已有 20 个核心测试及新增 27 个基础测试通过。该环境 Node 22 不是工程 Node 24 基线，仅作为开发检查；正式构建/API/浏览器和持久流程回归必须以本 PR CI 的精确 SHA 为准，尚不声明其通过。

新增 8 个真实 API 测试涵盖 40 路请求上下文、凭据不进入日志、固定错误码、请求大小、墙上时钟回拨、日志 sink 失败和错误启动。源码中测试计数不代替实际运行结果。

临时只读工具导出仅获取既有固定 Prettier/TypeScript 供隔离环境使用。另一个限次数据作业读取固定 SHA 的锁文件，仅加入固定 workspace link，校验前后 Git blob SHA 后写入未引用 blob；不 checkout 或执行仓库代码，不创建提交、不更新分支。两项临时工作流均从最终树移除。CI 继续冻结安装与源码不变检查。

## 非目标与限制

不实现数据库连接、租户授权、FakeRuntime、完整 OTel、日志持久化/背压、真实 Claude/Codex、生产发布。SecretValue 不是加密；诊断脱敏不证明任意秘密可被识别。代码工作台的展示和能力声明保持原样。

## 入口

[使用说明](../development/safe-foundations.md) · [ADR-007](../adr/ADR-007-safe-foundations.md)。完成后更新本记录和实施状态，下一项按依赖推进 ZT01-04。
