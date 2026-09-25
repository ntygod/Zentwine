# Zentwine · 众弦

**不同的智能，同一个团队。**

面向人类团队与不同模型 Agent 的研发协作平台。终态覆盖需求、项目、设计、开发、验证、发布和效果反馈。当前交付的是工程基础，不是完整产品。

## 已有实现

- pnpm / TypeScript monorepo，React 管理工作台与独立 Studio 入口。
- Fastify 只读 bootstrap API，共享契约、客户端、配置与结构化错误基础。
- 单元/API/浏览器测试与包边界检查；真实 Temporal + PostgreSQL 故障恢复实验单独保留在 `spikes/`。
- 真实模型、代码编辑和工作区执行尚未实现；默认界面仍为只读壳。ZT02-01新增显式开启的本机身份API和PostgreSQL会话，尚无登录UI/企业SSO/生产认证。

## 本地运行

先安装 Node **24.21.0**。本地启动不需要模型 Key、数据库或 Docker。

```bash
npm install --global pnpm@11.10.0
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

- 管理端：`http://127.0.0.1:5173/org/local/workbench`
- 独立 Studio：`http://127.0.0.1:5174/org/local/studio`
- API 存活：`http://127.0.0.1:4100/livez`

`pnpm dev` 先构建并同时启动三个进程；Ctrl+C 清理子进程。端口被占用会明确失败。当前仅支持本机开发，不能通过设置 `NODE_ENV=production` 绕过身份和持久化建设。前端开发时支持热更新；共享包和后端修改后需停止并重新启动。

`/readyz` 故意返回 503，表示不具备生产就绪条件；`/livez` 只说明 API 进程存活。不要把前者改成 200 来绕过部署门禁。

## 验证

```bash
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
pnpm doctor
python scripts/validate_plans.py
```

`pnpm build` 构建所有当前实现包。`pnpm typecheck` 在构建后单独检查类型。`pnpm lint` 检查源代码与依赖边界；`pnpm test` 运行核心和 API 测试。端到端测试使用构建后的页面与真实本地 API，不调用收费模型。需要 Linux 浏览器系统依赖时执行 `pnpm exec playwright install --with-deps chromium`。

## 开发资料

- [完整规划](docs/README.md)
- [开发状态](docs/tasks/status.md)
- [最新实施说明](docs/tasks/ZT02-01-execution.md)
- [架构与决策](docs/adr/README.md)
- [本地环境与版本](docs/development/foundation.md)
- [仓库协作约定](AGENTS.md)

当前软件包均标记 private / UNLICENSED，未自动授予新的产品发行许可；第三方依赖各自许可须保留。开源发布与商业部署另行记录决策，不阻塞内部开发。

配置、错误、请求追踪、时间/ID 与安全日志接口见 [ZT01-03 使用说明](docs/development/safe-foundations.md)。

## 测试基础

[ZT01-04 隔离测试指南](docs/development/testkit.md)包含FakeRuntime、双租户Fixture、临时PostgreSQL与浏览器并行测试。构建后运行 `pnpm test:fixtures`；真实数据库套件按指南准备专用服务后运行 `pnpm test:integration`，缺配置会失败。

### 工程质量门禁（ZT01-05）

安装 `quality/requirements.txt` 中的 Python 检查依赖并完成构建后，运行 `pnpm quality:check`。数据库迁移演练使用 `pnpm test:migrations`，必须接入专用临时测试库；真实模型验证状态用 `pnpm test:live` 单独查看。完整说明见 [质量门禁指南](docs/development/quality-gates.md)。

## 统一开发与故障环境（ZT01-06）

新成员从 [CONTRIBUTING.md](CONTRIBUTING.md) 开始。`pnpm doctor --profile fresh --json` 检查安装前置；`pnpm env:up/status/down` 管理独立合成基础设施；`pnpm drill --suite database` 自动启动专用环境、验证并清理；`pnpm tools:prepare` 明确准备固定Temporal工具后可运行 `pnpm drill --suite durability`。

完整命令、安全边界、离线与SIGKILL恢复见 [统一环境指南](docs/development/local-environment.md)。数据库使用临时存储，不用于保存真实业务。普通 `pnpm dev` 仍不需要Docker或模型密钥。

## 组织与登录会话

[ZT02-01身份开发指南](docs/development/identity-sessions.md)：独立本机身份数据库、受信任票据签发、会话/组织选择API，以及真实数据库集成测试。默认`pnpm dev`不读取身份凭据或自动迁移。

## 授权内核（ZT02-02）

本机身份模式下可显式启用资源目录授权，HTTP、工具与WebSocket共用策略。默认不开启，无新增登录/权限UI。见[授权指南](docs/development/authorization-policy.md)及[执行记录](docs/tasks/ZT02-02-execution.md)。`pnpm test:policy`运行纯规则，专用PG就绪后`pnpm test:policy-integration`验证真实边界。
