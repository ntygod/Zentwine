# 组织设置、访客与联邦身份端口

ZT02-05。仍是本机可信开发产品，不是公网登录或企业供应商认证。真实范围包括管理页面、组织设置、成员角色/撤销、身份绑定邀请、精确共享访客和目录搜索；以及可测试的SSO/SCIM适配端口。没有发送邀请邮件、公开注册或真实模型执行。

## 页面与默认行为

`pnpm dev`默认不连接身份库。管理工作台新增“组织设置与成员”，地址`/org/local/workbench/settings`；默认显示组织管理未启用，没有假成员。

启用组织服务后，使用操作员的一次性票据登录，选择已有组织。负责人可以修改设置、邀请既有人类身份、撤销邀请、调整成员角色和撤销组织会话。非负责人只能看到自己的权限范围、接受邀请和搜索当前可访问资源。访客不能读取组织成员清单、设置或供应商元数据。

浏览器不把票据、Cookie、邀请或同步凭据写入URL/localStorage。邀请原始凭据仅首次返回，复制后需通过可信渠道交给指定身份。网络结果未知不自动重试写操作。刷新、开新窗口不会创建任何模型执行。

## 数据库与角色

沿用[身份指南](identity-sessions.md)、[策略指南](authorization-policy.md)、[Agent指南](agent-delegations.md)和[审批指南](bound-approvals.md)的独立本机`zentwine_identity_dev`库，使用非超级用户`zt_identity_app`及操作员连接；不要使用生产DATABASE_URL。

1. 停止该开发库的API，备份需要保留的数据。
2. 由可信迁移操作员按manifest依次应用0001至0005的up，并运行各verify；已应用迁移不要重复手动执行。`test:migrations`只演练临时测试库，不会升级业务库。
3. 显式创建新登录角色`zt_organization_app`，要求NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOINHERIT、NOBYPASSRLS，无继承角色或表所有权；用本机安全方式设置随机密码，不提交配置。
4. 配好既有`ZENTWINE_IDENTITY_OPERATOR_ACK=local-development-only`及`ZENTWINE_IDENTITY_OPERATOR_URL`后执行：

```bash
printf '%s\n' '{"action":"grant-runtime"}' | pnpm organizations:admin
```

该命令授予组织角色固定最小权限，并给原身份角色增加访客/会话截止/联邦票据的只读检查权限；不创建角色、数据库或自动迁移。普通身份角色不能修改组织配置或签发供应商机器凭据。

额外设置`ZENTWINE_ORGANIZATION_DATABASE_URL`为同一loopback业务库的`zt_organization_app`连接，保留原`ZENTWINE_DATABASE_URL`身份角色连接。两者必须指向同一个主机、端口和数据库。沿用已有精确允许Origin配置；不得公网绑定。以环境变量启用：

```bash
ZENTWINE_POLICY_MODE=local ZENTWINE_AGENT_MODE=local \
ZENTWINE_APPROVAL_MODE=local ZENTWINE_ORGANIZATION_MODE=local \
pnpm identity:serve
```

再运行两个前端开发入口（不要同时启动另一个占用4100的API）。所有配置字段可见于`.env.example`和现有身份指南。凭据不得发到聊天、放入版本库或HTTP查询参数。

## HTTP接口

所有人类写请求需要有效Cookie、精确Origin、`x-zentwine-client:web`、会话绑定CSRF；组织请求另带`x-zentwine-context-version`。每次调用读取当前权限。

| 路径 | 方法与作用 |
|---|---|
| `/api/v1/system/organization-capabilities` | GET；真实开关和外部验证器未连接状态 |
| `/api/v1/orgs/:orgId/organization-self` | GET；当前成员或访客边界 |
| `/api/v1/orgs/:orgId/settings` | GET/PATCH；owner设置及expected_version |
| `/api/v1/orgs/:orgId/members` | GET；owner成员列表，最多200，超界显式失败 |
| `/api/v1/orgs/:orgId/members/:memberId` | PATCH；角色/状态与expected_version，禁止最后owner移除 |
| `/api/v1/orgs/:orgId/sessions/revoke` | POST；撤销自己或owner指定成员的该组织旧会话 |
| `/api/v1/orgs/:orgId/invitations` | GET/POST；最多100条记录；创建需request_id、受邀UUID、角色、类型、资源与设置版本 |
| `/api/v1/orgs/:orgId/invitations/:invitationId/revoke` | POST；带expected_version撤销未使用邀请 |
| `/api/v1/auth/invitations/accept` | POST；当前已登录受邀人消费invitation_token并轮换Cookie |
| `/api/v1/orgs/:orgId/catalog/search?q=` | GET；按权限过滤后最多20条，无隐藏总数/分页侧漏 |
| `/api/v1/orgs/:orgId/identity-connections` | GET；owner可见，最多20个连接 |
| `/api/v1/orgs/:orgId/identity-connections/:connectionId` | PUT；配置版本CAS，新建expected_version=0 |

邀请有效期1–168小时；访客访问最多1–30天，接受时重新计算且不超过签发上限。访客必须viewer并指定1–16个资源；普通member邀请不能附加资源授权。修改组织设置保守撤销未接受邀请。身份被移出后必须重新邀请，不通过直接PATCH恢复；IdP管理成员不能通过本地邀请绕过供应商停用。

## SSO与SCIM端口

`createSsoPort(repository,connectionId,verifier)`只供可信服务器适配器使用。当前没有内置的签名验证器、登录跳转、JWKS下载、nonce/state存储或供应商回调。禁止将未经验证claims直接交给它；测试中的fixture_only验证器只用于本地测试。

本机操作员显式绑定已登记普通成员：stdin JSON `{"action":"link","connection_id":"<UUID>","human_id":"<UUID>","subject":"<stable-subject>","external_id":"<stable-external-id>"}`。连接必须启用；一旦绑定，不允许原地更换issuer/client。外部映射是显式身份信任决定，不按邮箱查找或合并账号。

操作员`{"action":"credential","connection_id":"<UUID>","expected_version":1}`将最多一天有效的同步凭据写入环境变量`ZENTWINE_IDENTITY_SECRET_FILE`指定的全新`/tmp/`文件（0600）；只存摘要，不在console返回秘密。响应丢失无法恢复秘密，应显式轮换；没有自动续期。

规范化供应端口为`POST /api/v1/idp/connections/:connectionId/provisioning`，机器`Authorization: Bearer <secret>`，禁止Cookie和浏览器Origin。输入严格为`request_id`、`external_id`、`active`、`expected_version`。只更新已显式绑定主体，不创建陌生账号。版本冲突409需要重新获取权威版本；重试同request_id只返回历史回执，不把历史状态重新应用。

这不是完整`/scim/v2`：外部连接器还需完成RFC7644的资源、PATCH和错误格式转换等。没有实际供应商可用性/认证结论。

## 撤权与回退

组织会话截止按数据库原生时间比较，重新登录生成新会话后才可访问。其他组织不受一次组织会话撤销影响；显式Agent委派不因logout或单独撤销会话取消，但成员版本/状态改变会使旧委派失效。

IdP停用、禁用连接：同事务更新成员版本/状态、会话截止、审批与邀请。原WebSocket下一消息重新检查并拒绝；定期断开无硬实时SLA。重新启用连接不自动恢复映射，需显式同步active=true并重新登录。停用最后owner优先服从安全规则，须可信本机操作员恢复。

开关关闭并保留数据是正常回退；旧0005约束仍参与已启用身份检查。0005 down会撤销所有会话和访客并删除联邦数据，只能用于明确销毁开发数据。不是生产无损回滚。已经返回的数据或完成的操作不能撤回。

## 验证入口

```bash
pnpm check
pnpm test:organizations
# 按测试指南先准备被明确标记的专用临时PostgreSQL
pnpm test:organizations-integration
# 另需 pnpm exec playwright install --with-deps chromium
pnpm test:organizations-ui
```

三个真实浏览器场景同时连接真实临时PG和API，不是前端假数据；供应商proof仍是合成适配器，和外部SSO实测分别记录。现有回归全部保留。详见[测试记录](../testing/zt02-05-report.md)。
