# Zentwine · 众弦

**不同的智能，同一个团队。**

让一个团队共同使用不同模型与 AI coding 工具开发同一个项目。当前在建设团队协作、授权与运行交接底座；不是已完成的多模型执行平台。

## 从这里开始

| 要做什么 | 入口 |
|---|---|
| 看已交付范围、当前阻断 | [实施状态](docs/tasks/status.md) |
| 本机启动、参与开发 | [贡献指南](CONTRIBUTING.md) |
| 让 Agent 接手一个任务 | [AGENTS.md](AGENTS.md) |
| 查功能指南、架构与验证证据 | [文档导航](docs/README.md) |
| 查看远期完整范围 | [终态规划索引](docs/plans/README.md) |

## 当前能做什么

TypeScript monorepo 提供 React Workbench/独立 Studio、本机 Fastify API、显式开启的身份/组织/授权/审批与审计能力。运行协议、事件和产物整批校验已有本地实现；Studio 与终端提供显式的交接检查，本机 Git 端口可读固定提交/树/blob。

以上各有使用边界和限定验收，见 [开发指南](docs/development/README.md)。真实模型适配、可执行工作区、持久 Run/版本 CAS、完整仓库与组织连接仍未全部完成；本地 hash/报告通过不赋予执行权限。不能把目录占位或只读检查当成已接通 AI coding。

## 本地启动

使用 `.node-version` 的 Node **24.21.0** 与 `package.json` 固定的 pnpm **11.10.0**：

```bash
npm install --global pnpm@11.10.0
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Workbench：`http://127.0.0.1:5173/org/local/workbench`；Studio：`http://127.0.0.1:5174/org/local/studio`；API：`http://127.0.0.1:4100/livez`。

默认启动无需模型 Key、数据库或 Docker，不自动迁移、登录或执行 Run。`/readyz` 保持 503 表示未生产就绪。共享包/后端变更后需重启；完整设置和故障清理见 [贡献指南](CONTRIBUTING.md)。

## 开发检查

```bash
pnpm harness:context packages/db/src/index.ts
pnpm harness:check
pnpm docs:check
```

第一条只列出需阅读的目录指引，不执行其中命令。代码、浏览器、真实 PG 和故障演练按 [验证路由](docs/harness/verification.md) 执行，文档检查不能替代完整 CI。

软件包目前 private / UNLICENSED；第三方依赖许可另行保留。生产发布、真实供应商与商业部署不由本地演示自动授权。
