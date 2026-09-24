# ADR-008｜隔离测试基础与可控 FakeRuntime

状态：Accepted（本工作包范围）。日期：2026-09-24。任务：ZT01-04。实施和自审由负责人已授权的 AI 实施者承担，不声称独立第三方审批。

## 决定

复用 Node 内建测试运行器与 Playwright，不另建一套测试框架。在 `@zentwine/testkit` 实现纯内存、显式推进的 FakeRuntime 及不可变租户 Fixture。新增 Node 专用 `postgres` 和 `temporary-directory` 子入口，生产包的依赖规则仍禁止导入 testkit。

Fake 使用测试专属 `fixture.v1` 事件，含稳定事件 ID、序号和不可覆盖的 `fixture_only` 标记。字段保留 org/run/task/workspace/context/model 的语义；这不是 ZT12-01 的正式生产协议，也不标记 ZT12-04 完成。未来正式契约发布时由显式桥接及 conformance 测试迁移，不能将两份协议都宣称权威。

临时数据库使用真实 PostgreSQL 17.11，每个 handle 新建随机数据库与随机非超级用户角色。测试辅助库只依赖结构化 SQL 端口，`pg` 仅在根 devDependencies 和测试驱动中使用。复用已通过 ZT01-01 的 pg 8.16.3 依赖版本与完整性摘要；不导入 Spike 实现。

创建前要求 test 模式、独立环境变量、明确 disposable 确认、固定控制库/用户、IP 字面量回环地址、无查询参数，并验证预置服务器标记。初始化和删除只处理本 handle 创建的随机资源；已知 OID 变化时拒绝删除，不按名称前缀清扫其他测试。CREATE/DROP DATABASE 在事务外执行。

应用测试角色不拥有表、不具有超级用户或 BYPASSRLS 权限；Fixture 表启用 FORCE RLS，每个事务用同一连接和事务局部 tenant setting。回调失败回滚并关闭连接。该 setting 由可信测试工具设置，不是生产身份鉴别；应用代码能设置 GUC 不意味着用户已认证。生产 ZT02/03 必须另行验证。

## 备选与取舍

只用内存数据库无法验证 PostgreSQL 行安全和真实事务；SQLite 不代替 PG。每测试独立数据库及角色比共享表/全局清表启动成本更高，但跨文件/并行运行不会删除别人数据。不是为每个单元断言启动容器，服务容器在测试运行期间复用。

默认单元测试不连接数据库、不调用模型；显式集成命令缺配置则失败。浏览器每例独立上下文，两个 Worker 并行，网络拦截作为防误调用测试护栏，不代替系统沙箱。真实异构验收仍需独立 live 证据。

## 失败、清理与边界

finally 清理覆盖正常退出、断言失败和已确认的部分初始化失败；清理失败不隐藏，可重新 dispose。资源忙时拒绝删除，测试先 await 所有事务。进程 SIGKILL 或 CREATE 应答丢失不能保证 JS finally 执行，应销毁该次专用服务容器；不自动扫描并删除未知对象。

临时目录不接受任意删除根，校验 inode/dev；它是文件 Fixture，不是不可信代码沙箱。Secret、客户资料、模型 Key 不进入测试；测试日志和数据均为合成。测试权限不是业务权限，临时管理员不分发给运行中的产品。

## 依据与验证

[PostgreSQL CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html) 与 [DROP DATABASE](https://www.postgresql.org/docs/17/sql-dropdatabase.html) 定义了事务及连接限制。
[行安全规则](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) 明确超级用户及 BYPASSRLS 的边界。
[node-postgres 事务](https://node-postgres.com/features/transactions) 要求同一事务使用同一 client。
[Node test](https://nodejs.org/docs/latest-v24.x/api/test.html) 用于进程隔离及 Mock 生命周期。
以上资料核对日期为2026-09-24。真实运行结果以 [执行记录](../tasks/ZT01-04-execution.md) 关联的 PR 和 CI 为准。

## 回退

回退本工作包提交，移除新增测试脚本和测试专属依赖即可；没有生产数据库迁移。原有应用入口、核心/API断言和故障回归必须保留。
