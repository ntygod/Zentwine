# 权限矩阵与回归入口（ZT02-06-A）

本增量只交付机器可读矩阵、真实接口回归和证据校验，不交付审计界面或新的应急撤权产品流程。ZT02-06仍为InProgress。

## 使用

先按[组织生命周期](organization-lifecycle.md)和测试环境文档准备冻结依赖、构建与显式的一次性PostgreSQL测试环境。不得使用生产数据库或`DATABASE_URL`作为回退。

```sh
pnpm access-matrix:check
pnpm test:access-matrix
pnpm test:access-matrix --require-all-surfaces
```

`--check`只校验定义，不连接数据库，返回`definition_valid_not_executed`及`executed=false`。默认测试入口在真实PG上通过24个场景后返回`current_surfaces_verified`；这不是完整模块验收。`--require-all-surfaces`执行相同场景，但由于文件、预览、导出尚未实现，返回退出码2和`incomplete_surface_implementation`。任何测试失败、超时、缺配置、缺失/重复场景、skip/todo或源码变化返回1。其他参数不接受。

## 6×4矩阵

| 入口 | 跨租户 | 降权 | 旧授权 | 并发撤销 | 实际范围 |
|---|---|---|---|---|---|
| REST | 实际资源拒绝/不存在等价 | 旧会话拒绝、新viewer可读不可写 | 新deny覆盖缓存allow | 撤销先持锁，等待的读取重新核验 | 已实现的目录元数据，不是文件内容 |
| WebSocket | 真实TCP与独立重连 | 已建立连接拒绝旧权限 | 逐消息重新读取规则 | 已建立连接在真实PG锁后拒绝 | 目录工具通道，不是终端/模型会话 |
| 搜索 | 隐藏私有和外组织条目 | 旧会话拒绝、新viewer保留合法读取 | deny后搜索无该结果 | 实际搜索请求在撤销提交后拒绝 | 当前资源目录，不是全文搜索 |
| 文件 | 默认拒绝 | 默认拒绝 | 默认拒绝 | 撤销期间默认拒绝 | 未实现，仅保留入口探测 |
| 预览 | 默认拒绝 | 默认拒绝 | 默认拒绝 | 撤销期间默认拒绝 | 未实现，仅保留入口探测 |
| 导出 | 默认拒绝 | 默认拒绝 | 默认拒绝 | 撤销期间默认拒绝 | 未实现，仅保留入口探测 |

定义为`quality/access-matrix.json`，固定注册表与验证器为`scripts/access-matrix.mjs`，真实执行文件为`tests/access-matrix/boundaries.test.mjs`。12个目录功能授权单元与12个未实现路由防护单元分别计数；不得把24/24解释为六种业务能力全部完成。预留探测路径分别为GET `/api/v1/orgs/:orgId/files/:id`、GET `/api/v1/orgs/:orgId/resources/:id/preview`、POST `/api/v1/orgs/:orgId/resources/:id/export`。它们不是已经发布的文件API契约，也不覆盖任意猜测路径。实际业务落地时必须替换矩阵状态及测试，不能以菜单隐藏代替。

每个测试先以同一身份从真实HTTP读取已知资源，必须成功后才记录拒绝结果，防止“服务整体故障所以拒绝全部请求”被误判通过。REST和搜索使用真正loopback HTTP，WS使用已建立的TCP连接，没有route mocking。并发场景通过阻塞生命周期事件写入观察实际锁等待；不以睡眠时间猜测撤销顺序。仅保证事务授权检查边界，不能撤回已经送达的数据或已提交操作。

## 证据与失败

`reports/access-matrix-evidence.json`保存被测commit/tree、锁摘要、矩阵摘要、TAP摘要、精确通过场景ID、功能/预留单元计数及未交付项。`reports/access-matrix.tap`为原始Node测试结果。报告消费者必须核对退出码、状态、`executed`、源提交和摘要；单独看到历史TAP文件不是本轮通过。运行开始即覆盖旧报告为未通过，缺配置不能复用上次绿色报告。

CI数据库任务强制执行矩阵，再用缺配置负例确认非零退出，分别保存成功报告与负例报告。原有组织、身份、策略、Agent、审批、迁移、浏览器和持久性套件不删除、不替代；它们仍由总质量门禁组合核验。该工具不自行触发外部IdP/模型、生产服务或付费服务，不发起部署。

## 后续交付

ZT02-06-B为真实、脱敏、分页并重新鉴权的审计视图；ZT02-06-C为有权限、幂等、明确作用范围与恢复机制的应急撤权。现有组织会话撤销仍不等于撤销明确委派；不得把本增量并发测试冒称新的应急撤权操作已交付。
