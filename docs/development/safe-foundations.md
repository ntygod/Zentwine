# ZT01-03｜配置、错误、追踪与安全日志

本页描述已加入本工作包的接口，不表示业务身份、数据库连接、真实 Agent 或生产部署已经完成。

## 配置与启动

`parseConfig(env)` 保留原有 `{mode,host,port}` 形状并冻结返回对象；`parseServiceConfig(env)` 返回深度冻结的 server/logging/limits/shutdownTimeoutMs。显式传入环境，没有隐式 `.env` 读取、磁盘搜索、优先级覆盖或 `process.env` 修改。默认值只适用于未设置的变量；空字符串、无效数字与未知枚举值报错。

| 变量 | 默认值 | 限制 |
|---|---|---|
| NODE_ENV | development | development/test；production 仍拒绝 |
| ZENTWINE_HOST | 127.0.0.1 | 仅回环 |
| ZENTWINE_API_PORT | 4100 | 整数 1–65535 |
| ZENTWINE_LOG_LEVEL | info | debug/info/warn/error/silent |
| ZENTWINE_BODY_LIMIT_BYTES | 16384 | 整数 1024–1048576 |
| ZENTWINE_REQUEST_TIMEOUT_MS | 30000 | 整数 1000–120000；HTTP 接收请求超时，不是 Agent 或处理器执行期限 |
| ZENTWINE_SHUTDOWN_TIMEOUT_MS | 5000 | 整数 100–30000 |

无效配置在绑定端口前失败，启动错误只有固定事件、字段名与原因，不输出错误对象、输入值或环境快照。`pnpm dev` 仍按开发脚本固定三个本地端口；单独启动 API 可以显式传入所需变量。

`parseDatabaseConfig(env)` 是提供给未来数据库消费者的显式解析器，不被当前 bootstrap 调用，也不创建连接。调用时 `ZENTWINE_DATABASE_URL` 为必需值；验证 postgres/postgresql URL 的基本结构，并以 SecretValue 返回。正常 JSON/字符串化隐藏值；只有 `.reveal()` 明确取出。它不是加密、保险库、连接授权或生产 TLS 策略。其他服务的环境变量不会被本服务误当作配置错误。

## 错误边界

共享 `ERROR_CATALOG` 给出固定 code/status/message/retryable。API 使用 `AppError` 与 `publicError`，未知异常、异常链及任意 thrown value 统一为 internal_error，不使用其 message/stack/cause。框架已知的输入、413 和 415 错误有安全映射。错误中的 details 暂时固定为空；将来扩展必须逐字段定义公开信息。

retryable 是诊断提示，不是自动重复执行许可。未知内部错误默认 false；客户端不因本字段自动重放命令。兼容的 `apiError` 只供已有静态可信文案，已标 deprecated，新的边界代码不得传入自由文本。

浏览器只展示本地文案。响应 code/trace_id 长度及字符范围受限，details 和额外字段受限；无效远端响应不产生可展示的内部异常内容。

## 时间与标识

Clock.now() 提供 UTC 墙上时间，MonotonicClock.milliseconds() 只计算本进程耗时，不用于持久时间戳或跨机器排序。SystemClock/SystemMonotonicClock/RandomIds 提供真实实现；FixedClock/ManualClock/ManualMonotonicClock/SequenceIds 是显式测试夹具。返回 Date 的修改不影响测试时钟，单调夹具禁止负向推进。

领域包只定义端口，不引入 Node 或供应商库。telemetry 只新增对 domain 的类型依赖，锁文件只增加本地 workspace link，不改变外部包版本。

## 追踪与信任边界

每个公共 HTTP 请求获得新 32 位小写十六进制 trace_id、16 位 span_id；响应 x-request-id 与错误 trace_id 相同。忽略外部 x-request-id/traceparent/tracestate/baggage，不把它们作为权限、组织或执行 ID。

TraceStore 用每实例 AsyncLocalStorage 在 Promise/回调中传播不可变快照；child 保持 trace 并创建 span；bind 捕获原上下文。Fastify onRequest 使用 callback 在 run() 范围中继续，不能随意改成先创建上下文再在范围外调用 done。

parseTraceparent/fromTrustedParent 仅提供版本 00 的显式可信对等方接入基础。非法或不支持的版本新建 trace；tracestate/baggage 不传播。调用者必须先鉴权；当前公共 API 不开放信任开关。本实现不是完整 W3C/OTel SDK 或分布式采样/导出系统。追踪记录不得携带 org、actor、delegation 等授权事实。

## 安全诊断日志

日志为 JSON Lines，事件名采用固定集合，元数据不可被 fields 覆盖。HTTP 只记录方法、注册的路由模板、状态和单调耗时，不记录 raw URL、请求头、查询、请求正文、代码内容或原始异常。未知路径只记录 `(unmatched)`。

脱敏按标准化键递归过滤凭据及敏感内容字段；防御性匹配常见 Bearer/Basic、凭据 URL、API Key、JWT、密码赋值；可以注册最多 64 个已知明文秘密（每个 4–4096 字符）作精确替换。不能保证识别任意自由文本、编码、分块或未知格式的秘密，因此日志最小化是第一层防线。

默认限制：深度 8、每层 50 项、总遍历节点 1000、单字符串 2048 字符、整条记录 16 KiB。异常对象、非普通对象、循环及超限使用标记；不读取普通 getter、不调用输入 toJSON，不修改输入，阻止原型键。JavaScript Proxy 的反射 trap 仍可能执行，异常被捕获；这不是恶意 JS 的隔离沙箱。只有数据可进入日志接口，仓库代码仍需 Runner 隔离。

日志 sink 同步失败计入 droppedRecords，不递归记错、不泄漏 sink 错误、不影响当前 HTTP。日志库不持久化、不建立无界缓存；生产背压、异步输出错误、访问控制、留存和告警由后续可观测性/部署工作实现。诊断日志不是业务审计账本，不能以可丢失日志充当批准证据。

## 验证与边界

先 `pnpm build`，再 `pnpm test:foundation`。完整回归用 `pnpm check`、`pnpm test:e2e`、`pnpm docs:check`。不需要模型凭据，不宣称 ZT01-04 的 FakeRuntime、临时数据库或业务租户隔离已完成。

[执行记录](../tasks/ZT01-03-execution.md) · [决策](../adr/ADR-007-safe-foundations.md)
