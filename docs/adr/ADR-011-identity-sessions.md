# ADR-011｜持久身份与本机票据会话

状态：Accepted（ZT02-01 本机开发范围）；基线 main@921980b45926c46cc1d6fc8c0c1d5446b672fcfa。依据负责人既有授权由实施者决定和自审，不代表独立审查或生产安全认证。

## 决定

沿用 Issue #14 的本机一次性票据入口，而非在本轮临时发明密码注册/重置系统。受信任操作员使用独立数据库角色创建身份、组织、成员并签发五分钟票据。HTTP 不提供公共注册、角色修改或票据签发。后续SSO/邀请适配放在ZT02-05；通用资源与动作策略仍属于ZT02-02。

业务事实存PostgreSQL：humans、organizations、memberships、login_tickets、sessions。首个业务迁移为0001-identity-core。票据与会话使用32字节随机值，只存SHA-256摘要；票据原子消费和新会话创建同事务，丢失登录响应须另签票据，不能重放旧票据。

会话有效期上限八小时、空闲三十分钟，数据库时间是权威；轮换保留原始绝对截止。注销撤销本会话；身份状态变化递增auth_version，使此前会话与未用票据失效，即使后来重新启用也不能复活旧凭据。

活动组织在会话中保存，但只是一项经过验证的选择，不授予权限。切换要求expected_version，成功递增context_version。每次租户请求重新检查会话、身份、组织、成员状态，并要求URL组织与会话选择及版本相符。旧窗口返回409或404并重新读取会话；跨标签页不同组织需不同会话，此取舍优先防止上下文误用。

## 数据与执行边界

身份是控制面跨组织元数据，仓储用参数化SQL与组织/身份双条件查询，不将本模块宣称为全业务RLS。运行数据库角色不得为superuser、CREATEDB、CREATEROLE、BYPASSRLS或表所有者；只授予所需表操作，管理命令使用独立角色。数据库凭据/管理员和服务代码仍是可信边界；这不是针对数据库管理员的隔离。

事务明确使用READ COMMITTED；会话行锁序列化轮换与切换；锁等待结束后以新语句快照重查过期时间和身份epoch，不能沿用排队前结果。元数据以每请求查询时的已提交状态核验。不追溯撤回已发出的响应，不承诺跨网络“瞬时撤权”；后续有副作用命令必须在执行事务中再次核验，不能把本次GET上下文作为永久授权。

HTTP入口使用精确Origin、JSON与自有请求头；持有会话的变更还要求会话绑定CSRF。Cookie HttpOnly、SameSite=Strict、Path=/api/v1、无Domain。因为本轮只允许127.0.0.1 HTTP开发，使用明显标注的local cookie且不设置Secure；生产模式仍拒绝启动，不能把它直接部署到公网。不同同主机端口不构成安全边界。

原v0.1 bootstrap快照继续描述旧只读壳；新身份接口有独立v1.0.0协议。默认模式保持无数据库；显式local-ticket模式才连接身份库。没有UI登录页、企业IdP、Agent授权、持久审计outbox或完整生产发布。

## 参考

OWASP Session Management、CSRF Prevention与Authentication Cheat Sheets；Node.js crypto文档；node-postgres Pool文档。采用原则：不可预测会话、服务端撤销、CSRF独立防护、参数化查询；不以遵循部分建议声称全面认证。

- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- https://nodejs.org/api/crypto.html
- https://node-postgres.com/apis/pool

## 验证与回退

完整测试与最新CI见执行记录。保留所有原有断言；用真实专用PostgreSQL验证单次票据、重启、撤销、并发切换和HTTP边界。

关闭身份模式可恢复原只读壳而保留数据。down SQL会删除身份数据，仅用于空白开发库或已经备份并明确要销毁的环境；不自动执行回退、不在普通启动时迁移。上线/数据保留/备份仍需后续工作。
