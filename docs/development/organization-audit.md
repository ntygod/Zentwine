# 组织生命周期审计视图（ZT02-06-B）

本指南对照已合并的PR #27及PR #28源码编写，基线main `a30e7fe0257315fd7ad94c67c24a7b0772541d0f`。它补齐审计视图的使用与维护说明，不新增业务行为。原B代码验收见[测试记录](../testing/zt02-06-b-report.md)，当前任务边界见[执行记录](../tasks/ZT02-06-execution.md)。

## 能看什么，谁可以看

工作台入口是 `/org/local/workbench/settings` 的“组织审计记录”。只有当前组织有效、未被应急阻断的普通成员型负责人可查询；普通成员、只读成员、访客及Agent凭据不能读取。拥有某个共享资源的读取权不等于拥有组织历史读取权。服务端每页都重新核验，不依靠隐藏菜单授权。

这是已有组织生命周期事实的只读投影，不是完整安全审计账本。原B有九类事件；C新增两类应急事件，当前共十一类：

| 事件 | 已记录的事实 | 目标类型 |
|---|---|---|
| settings.updated | 组织设置更新 | organization |
| member.updated | 成员权限变更 | membership |
| sessions.revoked | 组织会话撤销 | human |
| invitation.created | 邀请创建 | invitation |
| invitation.accepted | 邀请接受 | invitation |
| invitation.revoked | 邀请撤销 | invitation |
| connection.updated | 身份连接配置更新 | identity_connection |
| identity.linked | 外部身份绑定 | external_identity |
| identity.provisioned | 规范化身份同步提交 | external_identity |
| member.emergency_held | 成员应急阻断 | membership |
| member.emergency_released | 成员应急阻断解除 | membership |

每条记录只返回事件UUID引用、UTC时间、事件类型、操作来源类型/UUID、目标类型/UUID。不返回姓名、邮箱、资源名称、原始请求、凭据、凭据摘要或全局计数。UUID仍可追溯，不等于匿名化。两个identity事件的actor来自原记录的连接，页面显示“归因连接”，不能据此推断人类操作员、启停方向或未保存的前后值。

登录失败、资源读取、Agent执行、完整审批轨迹和管理员直接SQL不在此视图中；没有记录不代表没有发生行为。没有公开事件修改/删除API，亦没有新增导出功能。

## 准备与迁移

沿用[组织生命周期指南](organization-lifecycle.md)的本机开发身份、精确Origin和独立数据库角色配置。默认工程模式不连接身份数据库，也不生成演示审计数据。仅启用组织服务不会自动应用迁移、签发凭据或调用模型。

0006在现有组织事件表增加非空唯一 `audit_ref` 和组织范围索引，为旧行补充UUID引用，保留原事实。必须按 `packages/db/migrations/manifest.json` 的顺序由可信操作员应用尚未安装的迁移并运行verify，不重复手工执行已安装的up。当前完整主线还包含0007，应按[应急控制指南](emergency-containment.md)处理其授权与回退限制；0006不是当前主线的全部安装要求。

管理连接沿用 `zt_organization_app`，普通身份连接沿用 `zt_identity_app`，不得将迁移所有者或超级用户用于服务。0006不要求给普通角色新增事件改写权限；当前0007的新增列和回执授权需操作员显式更新。`pnpm test:migrations`只演练临时数据库，不会升级实际业务库。缺迁移、缺读取权限或数据库故障返回失败，不伪装为空历史。

## 查询接口

`GET /api/v1/orgs/:orgId/audit-events` 使用已有浏览器会话Cookie及 `X-Zentwine-Context-Version`，路径组织必须与该会话当前组织一致。拒绝Agent Bearer；提供的Origin必须在精确允许列表中。GET不产生执行、邀请或审批副作用。

| 查询字段 | 契约 |
|---|---|
| kind | 省略或all表示全部已记录类型；否则必须是上表精确事件类型 |
| limit | 省略为20，允许1–50的整数；页面固定每页20 |
| cursor | 仅使用上一成功响应的next_cursor，不自行构造；绑定会话、组织、上下文版本、类型和页大小 |

响应为 `schema_version=1.0.0`、`org_id`、`scope=organization-lifecycle-only`、`complete_ledger=false`、`snapshot_at`、`entries` 和 `next_cursor`。末页 `next_cursor=null`；空页没有伪造游标。客户端按共享contracts严格解码组织、字段和事件归因；未知字段不是可直接展示的原始服务器内容。

分页按数据库bigint序号降序，先按组织及筛选条件过滤，再取页；相同时间戳和超出JavaScript安全整数范围的序号不转换为Number。首屏记录高水位，续页限定该高水位，新事件通过刷新查看。snapshot_at标记分页起点，不代表全库MVCC快照或所有业务行为已被记录。

游标使用实例随机秘密与会话摘要派生的密钥加密认证，初始快照后15分钟失效，续页不延长有效期。服务重启或另一个仓储实例无法使用旧游标，需要刷新第一页；事件本身持久保存。当前未实现跨实例共享游标密钥，多实例路由不可假定无缝续页。游标不是授权凭据，每页必须通过当前负责人/会话核验。

## 失败与页面行为

| 结果 | 处理 |
|---|---|
| 400 invalid_input | 查询或游标不合法、过期或绑定不匹配；丢弃游标并从第一页刷新 |
| 401 authentication_required | 会话失效，重新获取有效登录；不得以旧页面充当授权 |
| 403 forbidden | 当前有效身份不具备负责人资格，或请求来源/凭据类型不允许 |
| 404 unavailable_resource | 当前组织不允许访问，包括跨组织、组织停用、成员撤销或应急阻断等 |
| 409 version_conflict | 组织上下文版本变化，重新读取会话并选择正确组织 |
| 503 unavailable | 存储、迁移或运行权限不可用；显示固定错误，不显示驱动异常或伪空列表 |

响应使用 `Cache-Control: no-store`。筛选、翻页或刷新前清空旧审计结果；组织切换、退出、权限错误清空记录并丢弃旧世代响应。浏览器不把记录、游标和凭据写入localStorage/sessionStorage。页面没有主动远程擦除机制；其他窗口发生撤权后，当前窗口会在后续请求被拒绝时清空。已经返回的数据不能收回。

查询与既有组织写入遵循共享/独占组织锁协议，读取后再次核验会话及负责人资格；实际测试覆盖锁等待后失效。直接SQL或不遵守协议的新写入者不受此一致性保证。新写入者必须纳入协议和并发测试，不能仅依赖全局序号推断提交顺序。

## 回退与维护

优先停用页面或组织服务而保留数据，不以降级删除历史。仅在允许回退的独立开发环境、停服且备份后评估0006 down：它删除新增引用和索引，再up会生成不同引用，不能承诺外部引用稳定或在线无损回退。先核对后续迁移；0007发生应急历史后明确禁止down，不能越过它执行0006回退。

当前没有历史归档、保留清理、篡改外部证明或大型历史性能认证。普通角色不能改写已存在事件，但数据库管理员仍可修改。后续通用对象审计由ZT03-05负责，不把当前投影冒充其完成。

## 可复现检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:audit
# 先按testkit指南准备并确认可销毁的独立PostgreSQL测试环境
pnpm test:audit-integration
pnpm exec playwright install --with-deps chromium
pnpm test:audit-ui
```

缺数据库配置时后两个入口退出1，不静默跳过。冻结工具版本以仓库配置为准；真实模型及IdP验证与上述本机测试分开。CI仍执行全部身份、组织、策略、委派、审批、矩阵、应急、旧浏览器、迁移及持久性回归，不以文档检查替代它们。
