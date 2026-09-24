# ZT01-01：持久工作流技术验证

这是 Zentwine 的第一项开发实验，不是产品服务器、Agent 基座或可公开部署的 API。对应 [工程底座任务](../../docs/modules/01-foundation.md)、[ADR-001 提案](../../docs/adr/ADR-001-engineering-and-orchestration.md) 和 [真实验证报告](../../docs/testing/zt01-01-report.md)。

## 实际实现

TypeScript 实现输入校验、幂等命令、PostgreSQL 业务事务/outbox、绑定规格摘要的测试审批记录、Temporal 等待工作流、独立 Worker 子进程及故障注入。业务副作用只是在专用测试数据库中插入一行；不调用 Claude、Codex、Git 写入或部署工具。

测试使用真正的 PostgreSQL 和 Temporal CLI 开发服务器。Temporal 自身的开发持久化是 SQLite，业务权威数据存 PostgreSQL；不能把这份实验称为生产 Temporal/PostgreSQL 集群部署或高可用验证。

## 复现

已选测试环境：Linux x64、Node 24.21.0、PostgreSQL 17.11、Temporal CLI 1.9.1、TypeScript SDK 1.24.0。其他平台尚未验证。不要连接生产数据库。

在仓库根目录启动一次性测试数据库（固定口令仅用于本地合成测试）：

```bash
docker run --rm -d --name zentwine-poc-postgres \
  -e POSTGRES_USER=poc -e POSTGRES_PASSWORD=poc_local_fixture_only \
  -e POSTGRES_DB=zentwine_poc_test \
  -p 127.0.0.1:55432:5432 \
  postgres:17.11@sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232
```

等待 `docker exec zentwine-poc-postgres pg_isready -U poc -d zentwine_poc_test` 成功，再运行：

```bash
cd spikes/ZT01-01-durable-workflow
npm ci
export POC_DATABASE_URL='postgres://poc:poc_local_fixture_only@127.0.0.1:55432/zentwine_poc_test'
npm test
```

已提交通过验证的依赖锁；复现只使用 `npm ci`，不重新解析依赖。这只是隔离 Spike 的安装方式，未来主工程仍按 ZT01-02 建设 pnpm workspace；本 PR 不决定根项目包管理器。

默认测试 SDK 下载指定版本 Temporal CLI，网络或二进制不可用会明确失败，不用 Mock 冒充。也可设置 `POC_TEMPORAL_CLI` 为本机已核验的 CLI 文件；CI 对 Linux 归档执行固定 SHA-256 校验。首次依赖/二进制下载需要网络，不声明支持无缓存离线安装。

只跑不依赖数据库的检查：

```bash
npm run build
npm run test:unit
```

清理自己创建的本地数据库：`docker stop zentwine-poc-postgres`。测试自动清理自己的子进程、临时 schema 和 Temporal 文件，不删除其他 schema。不能中断测试后假设所有资源已自动删除；异常中断后检查自有测试容器及进程。

## 实验矩阵

| 检查 | 真实动作与断言 |
|---|---|
| 并发幂等 | 8 次同 scope/key 请求，只有一个首次创建和一个 start outbox；不同内容冲突 |
| 事务原子性 | 请求插入后、outbox 前抛错；两者一起回滚，随后可重新提交 |
| 启动应答丢失 | Temporal 已启动但 outbox 尚未确认；重派发得到同一 runId |
| 旧规格批准 | 不同 specHash 的批准被拒绝，不产生 effect |
| 等待与重启 | 等待状态杀 Worker，重启使用同一 SQLite 文件的 Temporal 服务；无 Worker 时收到信号，再恢复完成 |
| 提交后崩溃 | Activity 写入 PostgreSQL 后 SIGKILL；重启后实际发生重试，effect 仍只有一条 |
| 已完成流程与回放 | 完成后再次派发不创建新流程；用真实历史做 deterministic replay |
| 信号不等于授权 | 仅发送信号继续等待；拒绝决定不可覆盖为允许，effect 为零 |
| 取消 | 取消等待中的流程，验证取消异常和零业务副作用 |

`reports/poc-results.json`、测试日志、历史摘要和 CI 制品记录真实结果。文档中的矩阵是检查设计，只有对应运行成功才算通过。

## 明确未实现

没有用户身份认证、完整租户隔离、生产授权/撤权/审批过期服务、工作区租约、模型调用、UI、计费或部署。请求里的 org/actor 由合成测试输入，不能当作生产身份。取消工作流不会自动把业务请求改成 cancelled；生产状态投影和停止确认属于后续模块。等待测试只验证事件持久化与重启，不冒称实际持续等待了数月。

不宣称全局 exactly-once：Temporal Activity 可重复执行，这里依靠本地事务和唯一键让测试业务效果幂等。真实外部工具仍需其幂等键、操作记录、对账和 unknown 状态。

## 安全边界

数据库 URL 仅允许 loopback，数据库名必须以 `_test` 结尾；只创建随机前缀的测试 schema。SQL 数据参数化，唯一拼接的 schema 名经过严格白名单校验。故障开关仅用于此实验进程。长期测试 CI 使用只读仓库权限、不读取项目 Secrets、不接入收费模型、不发布服务。一次性锁文件导入及其删除记录见验证报告。依赖和开发服务器可访问互联网下载，但不包含客户材料。
