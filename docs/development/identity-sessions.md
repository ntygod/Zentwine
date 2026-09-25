# ZT02-01｜组织、会话与租户上下文

本轮是本机开发身份API，不是企业SSO、密码注册页面或生产认证服务。默认 `pnpm dev` 保持原来的只读界面；身份启用后也不会自动接通模型、工作区或生产发布。

## 数据库与首次配置

使用专门的本机 PostgreSQL 开发库 `zentwine_identity_dev`，不可复用生产库或ZT01临时测试库。数据库监听127.0.0.1且使用本机可用端口。由有权限的本机操作员在psql建立独立数据库所有者和运行角色：

```sql
CREATE ROLE zt_identity_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE zt_identity_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE zentwine_identity_dev OWNER zt_identity_owner;
REVOKE ALL ON DATABASE zentwine_identity_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE zentwine_identity_dev TO zt_identity_app;
\password zt_identity_owner
\password zt_identity_app
```

通过psql交互设置各自不同密码，避免出现在SQL文件或终端历史。运行URL和操作员URL分别对应不同角色；从本地秘密管理或受限环境注入，不提交到仓库。URL必须包含用户、密码和端口，无查询参数，库名固定。

设置 `NODE_ENV=development`、`ZENTWINE_IDENTITY_MODE=local-ticket` 和 `ZENTWINE_IDENTITY_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:4100`。

操作员命令额外需要 `ZENTWINE_IDENTITY_OPERATOR_ACK=local-development-only` 与 `ZENTWINE_IDENTITY_OPERATOR_URL`（owner URL）；服务启动则使用 `ZENTWINE_DATABASE_URL`（app URL）。不开启身份时不需要这些变量。没有自动读取dotenv。

```bash
pnpm install --frozen-lockfile
pnpm build
printf '%s' '{"action":"migrate","acknowledge":"development-database"}' | pnpm identity:admin
printf '%s' '{"action":"grant-runtime"}' | pnpm identity:admin
printf '%s' '{"action":"create-human","display_name":"开发者"}' | pnpm identity:admin
printf '%s' '{"action":"create-organization","display_name":"研发团队"}' | pnpm identity:admin
```

保存命令返回的随机UUID。随后用JSON标准输入执行 `membership`：字段为 `org_id`、`human_id`、`display_number`（例如MEM-1）、`role`（owner/member/viewer）和 `status`（active/revoked）。这是本机受信任配置入口，不是对普通用户开放的HTTP操作。

运行 `issue-ticket` 并提供human_id，票据写入 `.zentwine/identity/ticket-*.json`：目录0700、文件0600、五分钟过期、只用一次。stdout只显示文件位置。不要上传该目录、不要把票据放进URL/Issue/截图，使用后删除文件。文件写入失败时需要另签票据，旧票据到期自行不可用；暂未做历史行保留清理任务。

另开终端，仅配置运行角色URL及身份模式/来源，再执行 `pnpm identity:serve`。它监听现有API端口，不能与默认 `pnpm dev` 的API进程同时占用4100。启动不自动创建库、应用迁移或签发凭据；缺表或高权限运行角色均拒绝。

## HTTP流程

所有变更要求 `Origin` 精确命中配置、`Content-Type: application/json`、`X-Zentwine-Client: web`。登录后还要 `X-Zentwine-Csrf`，取自session响应；浏览器请求携带Cookie，身份值不保存在localStorage。

| 方法与路径 | 内容 |
|---|---|
| POST /api/v1/auth/login | JSON ticket；成功用Set-Cookie建立新会话，同时撤销所携带的旧会话 |
| GET /api/v1/auth/session | 身份、合法组织、选择版本、过期时间和CSRF；不返回原始会话凭据 |
| POST /api/v1/auth/organization | org_id + expected_version；重查成员关系，再更新选择版本 |
| GET /api/v1/orgs/{orgId}/context | 要求X-Zentwine-Context-Version；返回自己的组织/成员上下文，不提供任意成员查询 |
| POST /api/v1/auth/rotate | expected_version；轮换Cookie，旧Cookie失效，不延长八小时绝对上限 |
| POST /api/v1/auth/logout | 空JSON对象；撤销会话并删除Cookie |

登录响应形状为 `schema_version + session + csrf_token`。选择组织前active_org_id为null；新会话context_version为1。成功切换版本+1，即使目标与原组织相同也构成显式选择。两个窗口同时提交旧版本只允许一个成功；旧窗口必须重新读取session，不能把409当作自动重试写入许可。

组织/成员显示编号不是授权ID。即使两个组织都有MEM-1，请求仍以已认证human、已选org、选择版本和当前membership约束。撤销成员后session仍可用于选择其他合法组织；停用人类身份会使旧票据和旧会话全部失效。role在本轮是事实，不代表ZT02-02所有动作授权已经实现。

写入会话使用一次性票据、版本锁或幂等撤销，不承诺对重复POST返回同一登录凭据；登录/轮换响应丢失须重新登录。关键副作用的通用幂等与授权仍在后续业务命令层实现。

## 测试

```bash
pnpm check
pnpm test:identity-security
# 按testkit指南设置专用测试数据库后：
pnpm test:identity
pnpm test:migrations
```

单元/API负例使用明确注入的假仓储；真实身份集成使用随机独占数据库、真实pg驱动、非superuser运行角色和生产仓储。测试不会配置公网IdP或收费模型。原9个浏览器测试仍验证旧界面，本轮不把它们当作登录UI验收。

## 边界

仅本机可信开发环境。Cookie在HTTP下无Secure；生产NODE_ENV依然禁止。进程内限速不是分布式风控。没有公开注册、密码/恢复流程、SSO、邀请、登录UI、会话列表UI或耐久审计。现有bootstrap v0.1保持旧客户端协议，identity=false描述旧壳模式，不用于判断单独启用身份接口的授权状态。

当前身份元数据不是通用业务RLS实现；没有资源策略时其他业务入口仍拒绝。参数化查询和租户上下文必须继续用于后续模块，不能把context对象当作永久授权。数据库故障返回安全503，旧数据或假身份不能作为回退。
