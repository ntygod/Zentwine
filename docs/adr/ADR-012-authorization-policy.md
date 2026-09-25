# ADR-012｜统一授权内核与受控资源执行

状态：Accepted（本机身份范围）。任务 ZT02-02，输入 main@979ec37761f52390c938297de63cbcabffb2c0ad。实施者按项目负责人的既有授权作出决定，不代表独立第三方安全审计。

## 决定

纯 `@zentwine/policy` 以角色、精确资源关系、动作与服务器环境属性计算 allow / deny / needs_approval。默认拒绝未知角色、动作、过时事实和不完整配置。显式拒绝优先；组织 owner 不是受限资源的万能访问者。精确 reader 绑定不能把组织 member 的写权限扩展到私人资源。

权威事实来自 PostgreSQL；客户端只选择目标 ID、动作及预期版本，不能提交权威身份、环境、角色或自称已批准。评估输出携带策略版本、组织策略修订、成员及资源版本、评估时间和到期时间，固定 `reusable:false`。输出不是授权票据，也不是 ZT02-03 的 PolicySnapshot。

原生资源目录保存权限相关元数据，而非项目、工作区或代码模块的全部实现。当前真正可执行动作只有目录读取和显示名称修改；其余已知动作只评估，不伪装执行。needs_approval 的执行返回 403，审批签发属于 ZT02-04。

HTTP、服务器绑定的工具入口、真实 WebSocket 消息共用 `PolicyRepository`。每次消息都重新授权。没有通用“拿 allow 再执行任意回调”的接口。工具入参没有主体字段，绑定作用域由可信服务器建立；本轮不是 Agent 身份或 MCP 服务。

## 一致性与撤权

顺序为：会话行锁 → 人类共享 advisory lock → 组织共享锁 → 成员共享锁 → 策略共享锁 → 写目标行锁。身份停用、组织停用、成员修改使用相应独占事务锁；策略管理使用组织策略独占锁。锁后在 READ COMMITTED 下重新读取会话状态和时效。资源修改的 SQL 再核对短期有效边界与目标版本。

这定义提交顺序：已经持有授权锁的写入可先完成，撤权等待其提交；撤权返回后，新动作不能使用旧事实。资源锁等待导致的自然到期仍在锁后重核。并不声称可以撤回已返回数据或已经发生的外部操作。

advisory lock 是可信仓储之间的协作协议，不阻挡数据库管理员直接 SQL，也不是跨进程身份认证。未来新增身份或授权修改代码必须遵守相同锁键和顺序。哈希碰撞只增加竞争，不增加权限。当前读写锁粒度较粗，无分布式授权缓存。

## WebSocket

采用核对过的 `ws@8.21.3`（MIT）而不是自编帧解析。关闭压缩，限制负载、分片、缓冲、连接数、每会话连接、消息速率、空闲期限以及单连接并发命令。握手验证 Cookie、精确 Origin、本机 Host 与组织上下文；每条消息另带会话绑定 CSRF。URL 和子协议不接受秘密。会话定期复查，但不把连接本身当成权限。当前是目录请求/响应，不是完整事件订阅、终端代理或推送系统。

新增依赖通过只读一次性准备作业生成锁和依赖证据，固定已知基线，无 secret 注入或仓库写权限；准备工作流不保留在最终树。正式 CI 使用冻结安装和依赖审计。

## 取舍与后续

不引入全套通用策略语言或第三方策略服务器，先固定可审查的规则与端口。精确授权目前由本机操作员配置；管理 UI、租户自服务、授权继承和审批由后续任务实现。生产身份仍关闭；本机 HTTP Cookie 的已有风险边界不变。私有资源必须有读权限才能通过公共评估及修改入口，暂不支持盲写。

回退：先关闭 `ZENTWINE_POLICY_MODE`，保留数据；移除 0002 仅适合明确销毁的开发数据，不能自动对真实库执行。0001 迁移与原有测试不改写。

## 依据

- OWASP Authorization Cheat Sheet：默认拒绝、逐请求检查、对象级权限及关系/属性规则。https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP WebSocket Security Cheat Sheet：Origin、会话与逐消息授权。https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- PostgreSQL 17 Explicit Locking：事务锁及 advisory lock 边界。https://www.postgresql.org/docs/17/explicit-locking.html
- ws 官方发布与接口说明：https://github.com/websockets/ws/releases/tag/8.21.3

检索日期 2026-09-25。设计依据不等于所有生产威胁均已通过测试。
