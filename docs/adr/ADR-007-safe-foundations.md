# ADR-007｜配置、错误与诊断基础

状态：Accepted（实现者依据项目负责人的既有决策授权作出）。日期：2026-09-24。关联 ZT01-03 / Issue #6。接受的是本工作包设计，不是独立第三方审计或生产批准。

## 决定

保留 Node/TypeScript 及外部依赖版本；配置由显式 env 解析，深度冻结；可选服务的必需配置只在消费者显式解析时要求。继续拒绝 production bootstrap。

公开错误由共享 catalog 决定，不使用上游 message/stack/cause；未知错误不默认可重试。保持原响应字段，限制客户端接收的错误形状。

采用 Node AsyncLocalStorage 维护请求级诊断上下文；公共入口重新生成 trace，显式可信对等方才允许接续。只实现 W3C traceparent v00 子集，不引入完整 OTel 集成和外部遥测平台。

墙上时间与单调耗时分离，ID 来源显式；domain 保持纯端口。日志最小化与有界脱敏结合，未知对象不执行序列化方法。运行日志是尽力诊断，不作为耐久审计记录。

## 代价与备选

完整 OTel SDK 能提供更多采样、导出及集成，但当前只有本地 API 和界面骨架；先稳定诊断端口和测试，再由后续任务接入。手工向每个函数传 trace 较直观，但易遗漏异步调用；选择 ALS 并验证并发和恢复边界。消息驱动的跨进程关联仍由显式事件协议传递，不依赖进程内 ALS 跨进程生效。

通用序列化日志容易泄漏上下文，选择字段白名单和敏感值防御。正则不是任意秘密检测器；不以其存在为理由记录客户原文。SecretValue 只防误序列化，不等同保险库。

## 验收和回退

新增配置边界、异常分型、异步隔离、时钟、脱敏与真实 HTTP 测试；保留全部既有核心/API/浏览器和持久流程检查。精确结果见执行记录及 PR Checks。回退本 PR 恢复前一工程，无业务迁移；不单独移除测试放行代码。

## 官方依据（2026-09-24 核对）

- [Node AsyncLocalStorage](https://nodejs.org/api/async_context.html)：run() 与异步上下文范围。
- [Fastify Hooks](https://fastify.dev/docs/latest/Reference/Hooks/)：生命周期及 callback/async 约定。
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)：traceparent 格式、非法标识及安全考虑。本次仅实现所述 v00 子集。
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)：敏感数据排除、注入防护及日志故障测试。
