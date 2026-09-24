# 工程基础：开发与版本

## 本轮边界

ZT01-02 建立正式工程、共享包边界和两个可运行入口。页面是工作台骨架，不是完整 Coding 编辑器；没有示例任务、虚构执行或付费供应商请求。当前 API 仅开发模式、仅 loopback。组织身份和持久化未完成前业务接口统一拒绝。

## 固定基线

| 项 | 版本 | 依据 |
|---|---|---|
| Node | 24.21.0 | Node 官方 LTS 页及前序 CI 实测 |
| pnpm | 11.10.0 | 固定 JS 系列，不随 native 新主版本自动迁移；本轮 CI 验证 |
| TypeScript | 6.0.2 | Vite 官方 React TS 模板所用系列 |
| React / react-dom | 19.3.0 | npm 官方注册记录；本项目只用客户端渲染，不引入 Server Components |
| Vite | 8.3.0 | 官方 create-vite 9.2.1 的模板依赖 |
| React Vite plugin | 6.1.1 | 同上 |
| Fastify | 5.12.5 | 官方发布的安全补丁版本 |
| Playwright | 1.63.0 | 官方 npm 注册记录；浏览器测试锁定同一包版本 |
| Temporal SDK / CLI | 1.24.0 / 1.9.1 | 隔离 Spike 已验证，不加入 bootstrap 进程 |

精确传递依赖以 pnpm-lock.yaml 为准。使用固定版本并不等于永久无漏洞，CI 检查当时的依赖告警。首次工程解析的 lock 经检查后提交；最终 CI 必须 frozen 安装。

## 命令与服务

根目录 `pnpm dev` 固定本机端口 4100 / 5173 / 5174，先构建再启动。避免把可改变跳转目标的任意 URL 注入前端；正式环境路由与身份属于后续明确契约。

Workbench 和 Studio 独立构建，共用 contracts、client、ui。应用包通过 workspace 依赖引用已编译包；全新 checkout 先 `pnpm build` 再单独 typecheck/test。新增包要登记 `scripts/check-boundaries.mjs` 的显式依赖策略。

`/livez` 表示进程可读；`/readyz` 返回 bootstrap_only/503。公共 bootstrap 不包含用户、仓库路径、凭据、任务或会话。真实业务 API 尚未实现时返回统一 401，未知页面不生成资源。

## 安装、异常与清理

依赖安装需要可访问 npm 或组织镜像。已填充对应 pnpm store 的机器可尝试 `pnpm install --offline --frozen-lockfile`；缓存不足会失败，不声称全新断网安装可成功。

端口冲突：停止占用者或使用其他开发会话，不使用 --strictPort 自动选新端口破坏联动。Ctrl+C 会停止本次创建的子进程；Linux 故障清理由进程组控制，Windows 支持路径但需另做目标平台 CI 后才声明验证。

不需生产环境变量和模型密钥。不要把此无身份骨架暴露公网。移除本轮新增 apps/services/packages 与对应工作流可回退，无生产迁移。

## 资料

- [Node](https://nodejs.org/en/about/previous-releases)
- [pnpm](https://pnpm.io/installation)
- [Vite](https://vite.dev/guide/)
- [官方模板](https://github.com/vitejs/vite/blob/create-vite%409.2.1/packages/create-vite/template-react-ts/package.json)
- [Fastify 5.12.5](https://github.com/fastify/fastify/releases/tag/v5.12.5)
