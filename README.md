# Zentwine · 众弦

**不同的智能，同一个团队。**

面向人类团队与不同模型 Agent 的研发协作平台。终态覆盖需求、项目、设计、开发、验证、发布和效果反馈。当前交付的是工程基础，不是完整产品。

## 已有实现

- pnpm / TypeScript monorepo，React 管理工作台与独立 Studio 入口。
- Fastify 只读 bootstrap API，共享契约、客户端、配置与结构化错误基础。
- 单元/API/浏览器测试与包边界检查；真实 Temporal + PostgreSQL 故障恢复实验单独保留在 `spikes/`。
- 真实模型、身份、业务持久化、代码编辑和工作区执行尚未实现；界面明确显示这些边界。

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
- [本轮实施说明](docs/tasks/ZT01-02-execution.md)
- [架构与决策](docs/adr/README.md)
- [本地环境与版本](docs/development/foundation.md)
- [仓库协作约定](AGENTS.md)

当前软件包均标记 private / UNLICENSED，未自动授予新的产品发行许可；第三方依赖各自许可须保留。开源发布与商业部署另行记录决策，不阻塞内部开发。
