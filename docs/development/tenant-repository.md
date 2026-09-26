# ZT03-01｜租户数据访问与数据库隔离

当前为独立业务数据访问原语，不是对全部历史数据库表完成RLS改造。入口是 `PostgresTenantRepository`；没有新增公开HTTP/WS接口、页面或模型工具。最终验收与合并以本工作包PR为准。

## 数据边界

0008增加 `zentwine_tenant.object_keys` 和 `object_links`，仅存组织内对象UUID、命名空间类型、创建人、创建时间及同组织关联的端点。不是万能JSON内容表；Spec/Project等业务内容、版本/CAS、批准及关系语义由ZT03-02和所属领域负责。未来接入方必须在调用此内部端口前执行具体资源授权；RLS只保证组织隔离，不赋予访客查看整个目录的权限。目前拒绝guest，普通viewer只能读，owner/member可新增，运行角色不能更新或删除登记记录。

两个表均启用 `ENABLE` 与 `FORCE ROW LEVEL SECURITY`。限制性tenant_fence与读取/插入策略共同生效；主键和关联外键均含org_id，同一个UUID可以存在于不同组织而不泄漏存在性。批量读取与关联查询不依赖调用方补写org过滤条件。返回固定结构，不接受SQL、表名或任意投影表达式。

ZT02现有身份、组织、审批、委派属于独立控制面，继续使用原有会话及锁协议，本次没有宣称这些表已经迁入本RLS层。旧的资源读取、审计、应急页面保持原行为与测试。

## 租户上下文不是任意设置项

调用者传入服务器已有的session_digest、org_id、context_version。digest视为敏感凭据，不发给浏览器、模型、日志或URL。数据库的受限SECURITY DEFINER函数复核真实会话、人、成员、组织、上下文版本、组织会话截止和应急标记，取得会话行及人→组织→成员→策略共享锁，再重新核验。

绑定写入调用方无权访问的 `zentwine_tenant_private.contexts`，以真实backend PID、当前xid8和登录角色限定作用域。调用方修改任意GUC、search_path或传入其他组织都不能赋予访问权。同一事务不能再次绑定，包括显式结束绑定之后。正常结束会清空会话摘要与组织信息，保留本事务标记；下一事务重建，异常整体回滚。下一次绑定还清理已断开连接的旧标记，不持久保留应用访问历史。

所有definer函数固定 `search_path=pg_catalog, pg_temp` 并使用全限定表名，默认PUBLIC执行权被撤销；无动态SQL、角色切换或不可信对象查找。只有固定的绑定、读取身份及结束函数向运行角色开放。数据库管理员及具备迁移权限的人仍可修改结构，不属于对抗恶意管理员的保证。

每次语句的RLS函数复查有效身份；repository在结束事务前再次核验，过期或失效时不返回成功并回滚写入。已开始的合法事务与后来的撤权以共享/独占锁排序；不能撤回已经传给可信回调的数据或提交的外部行为。回调内不要执行外部副作用，不得在同一数据库等待持锁目标的撤权完成，否则可能形成应用层等待环。

## 连接与生命周期

为新数据层使用单独pool和登录角色，不重用身份/组织管理pool，更不能传入迁移连接。每次事务检查SUPERUSER、BYPASSRLS、CREATEROLE、CREATEDB、REPLICATION、角色继承、表/函数/命名空间所有权、DDL/TEMP和控制面凭据表权限；不安全配置拒绝执行。数据库只按授权上下文过滤数据，不将租户保存在全局变量或连接级GUC中。

`transaction(scope, async repo => ...)` 内可调用 `register(id,kind)`、`getMany(ids)`、`link(source,target,kind)`、`linked(source)`；批量上限100，关联返回超过100明确失败，不静默截断。必须等待每个异步操作。回调结束仍有未完成操作时，先关闭端口、排空语句，再回滚，不能在归还连接后执行。捕获内部错误也不会让部分事务提交，逃逸的端口在结束后拒绝使用。

驱动错误统一映射为固定TenantError，不返回SQL、数据库约束详情或凭据。提交结果不明确时返回unavailable，不自动重试；后续Operation与远端对账语义属于ZT03-04。当前新增登记按组织内ID幂等，已存在ID的kind不同则冲突，不覆盖。

## 安装与迁移

沿用 `pnpm identity:admin` 的本机 `migrate` 迁移入口（标准输入为 `{"action":"migrate","acknowledge":"development-database"}`）和统一manifest/ledger：逐文件摘要、事务、精确历史校验、verify及按逆序回退演练；新增0008而不修改0001至0007，也不放宽迁移语句门禁。迁移连接通过 `ZENTWINE_IDENTITY_OPERATOR_URL`，必须满足既有本机配置与 `ZENTWINE_IDENTITY_OPERATOR_ACK=local-development-only`，不能注入普通运行环境。

操作员预先创建单独 `zt_tenant_app` 登录角色，使用 `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`，不授予任何角色成员关系、表/函数所有权或公共建库/TEMP权限。凭据通过私密配置设置，不出现在命令行或仓库。数据库owner可为受控迁移角色；测试还验证了专门NOLOGIN/NOBYPASSRLS owner实际安装。已有控制面表的SELECT、会话行锁所需的UPDATE(id)，以及创建复合边界所需的人员/组织REFERENCES(id)只给受控迁移所有者，不给tenant runtime。

应用0008后，以同样受控的本机操作员配置运行 `pnpm tenant:admin`，标准输入为 `{"action":"grant-runtime"}`，只为已存在的zt_tenant_app授予CONNECT、公开数据schema USAGE、两个表SELECT/INSERT和五个固定函数EXECUTE，不创建用户或签发凭据。领域服务再用其独立DSN创建pool，构造repository并调用assertRuntimeRole；本增量没有把新池自动启用到HTTP服务。

0008仅空表时允许down。回退在独占锁与事务内检查是否已有登记对象；有数据时拒绝，恢复原FORCE设置，不删数据。未来版本采用向前修复或独立审阅的数据迁移。没有执行业务库迁移或部署。

## 验证

`pnpm test:tenant` 运行规则和事务控制单测；`pnpm test:tenant-integration` 在明确确认的专用临时PostgreSQL执行RLS/角色/批量/关联/连接复用/撤权/超时/回退测试，缺配置退出1。已有八项迁移演练自动覆盖新增manifest项；全部旧数据库、浏览器和Temporal回归保持。

技术依据：PostgreSQL 17官方《Row Security Policies》和《CREATE FUNCTION》关于FORCE/BYPASSRLS、约束检查与固定search_path的说明（https://www.postgresql.org/docs/17/ddl-rowsecurity.html；https://www.postgresql.org/docs/17/sql-createfunction.html）。RLS不是可信租户身份的替代品，也不涵盖TRUNCATE或恶意管理员，因此运行权限和绑定验证必须同时存在。
