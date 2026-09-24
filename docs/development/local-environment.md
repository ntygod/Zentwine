# ZT01-06｜统一本地环境与故障演练

## 适用范围

本入口管理 Linux 本机开发与合成故障测试，不是生产部署，不是运行不可信仓库代码的安全沙箱。Workbench、Studio、只读 API 仍由 `pnpm dev` 在宿主机运行；原有应用并没有因此接入持久业务数据。Docker Compose 只启动固定镜像的专用 PostgreSQL，同时准备 testkit 控制库和原技术实验的工作流测试库。

数据放在容器 tmpfs，down 后丢弃；无客户数据、无真实模型、无业务迁移。PostgreSQL 可用不等于身份/工作区/Agent 已实现。Temporal 仅在故障套件中启动，由套件按需要创建、杀 Worker、重启并清理；其 SQLite 开发历史不冒称生产 Temporal 集群。

## 一、按需要检查环境

```bash
node scripts/doctor.mjs --profile fresh --json
pnpm doctor
pnpm doctor --profile integration --json
pnpm doctor --profile faults --json
```

fresh 只检查系统、Node/pnpm、Git与锁；app 另外检查依赖/构建/4100、5173、5174端口；integration 检查 Python 验证模块、flock、本机 Docker 与 Compose；faults 再检查隔离 Spike 和固定 Temporal CLI。默认 profile=app，适用于构建后且尚未启动页面的环境。

返回非0表示存在未就绪项；不会安装工具、拉镜像、终止占用端口的进程、读取模型Key或打印原始配置。端口被自己已启动的会话占用时，先停止该会话，不自动选取新端口掩盖问题。

## 二、开发环境单独启动和停止

```bash
pnpm env:up
pnpm env:status
pnpm env:down
```

up 可按摘要拉取缺失镜像；已有相同健康环境则复用，不另建数据库。`pnpm env:up --offline` 禁止镜像拉取，缓存缺失失败。status 不启动容器，返回固定状态及本机分配端口，不打印连接字符串或密码。

环境使用随机的 Compose project、owner 标签和动态的 loopback 端口，因此不同 checkout 可并行。状态保存在 `.zentwine/environment/`，只有本地用户可读；临时凭据随机生成，单独以0600文件保存。Docker 容器环境并非秘密保险库；本地 Docker 管理员具有相应可见性。

每次操作先解析 Docker context/DOCKER_HOST，拒绝 TCP、SSH 和非本地 Unix socket；后续命令显式固定同一 socket 和 daemon ID。不继承 COMPOSE_FILE、自动 .env、生产 DATABASE_URL、模型Key或 NODE_OPTIONS。固定 Compose 文件与空 env-file 防止无意加载其他项目配置。

使用 util-linux flock 控制本 checkout 的环境变更；锁文件不删除，内核在进程退出时释放。不会通过旧 PID 文件误杀进程。down 先核对 project 内每个容器/网络的 owner 标签、daemon 和 Compose 摘要；不删除陌生资源、不执行 system prune、不删除镜像。重复 down 返回 absent。

## 三、自清理的验证入口

先完成主工程 build，Python虚拟环境配置见 [贡献指南](../../CONTRIBUTING.md)。

```bash
pnpm drill --suite database
```

这个命令不用共享的 env:up 实例，而是创建独立的 session 环境，运行已有数据库隔离和迁移套件，并在 finally 中清理。不同会话不共用数据库与宿主端口。详细结果在 `reports/drills/<session>/`，含步骤、清理状态及合成/live边界；日志中的本轮随机凭据与数据库URL被替换。

完整故障演练需显式准备已锁定依赖和工具：

```bash
npm ci --prefix spikes/ZT01-01-durable-workflow
npm run build --prefix spikes/ZT01-01-durable-workflow
pnpm tools:prepare
pnpm drill --suite durability
# 或依次运行数据库/迁移以及原工作流故障套件
pnpm drill --suite all
```

`tools:prepare` 只下载清单固定的 Linux x64 Temporal CLI，验证官方归档SHA，再从归档验证可执行文件字节。不会执行任意路径或自动升级。`--offline` 只验证已有完整缓存，不下载；缓存损坏不自动覆盖。工具准备不隐式安装 Spike npm依赖，也不购买服务。`drill --offline` 禁止拉缺失镜像，所有工具必须提前准备。

原实验输出目录是共享的，因此新入口对旧实验的执行/结果收集加独立锁；不要同时绕过新入口直接运行旧实验并期望报告隔离。真正的执行环境仍按session隔离。

## 四、失败、取消与恢复

普通异常、SIGINT、SIGTERM会先结束本次子进程组，再在不使用已取消信号的情况下清理环境。子进程有时限和输出上限；只有任务与清理都成功，drill 才成功。创建结果未知或清理失败时保留 session 与明确失败状态。

SIGKILL、宿主机断电、Docker故障不能由JavaScript finally保证清理。每次演练开始都显示16位 session ID；恢复后先检查再清理该记录：

```bash
pnpm env:status --session <16位session>
pnpm env:down --session <16位session>
```

只接受该checkout合法session，不接受任意路径。工作区/daemon/Compose摘要变化时拒绝自动清理：先核对原始记录、恢复对应可信配置，再执行；不要改状态文件来跳过检查。文件锁随进程退出释放，不需要 `rm lock`。

纯本地可信工具假设仍然存在：同权限用户篡改文件、替换Docker socket或运行库不属于这些标签的安全保证；它们是避免误操作的约束，不是抵御管理员的边界。

## 五、开发进程与离线安装

`pnpm dev` 仍可用；未知参数、production模式和端口冲突先失败。子进程只继承允许的环境字段；退出时按本次进程组清理，并给超时组发送停止信号，不按端口杀陌生进程。

已填充 pnpm store 可用 `pnpm install --offline --frozen-lockfile --ignore-scripts` 复验。空缓存明确失败，不冒称新机器无网络可安装；浏览器/系统库、Python包、镜像、Temporal工具各有独立缓存。CI 同时验证冷缓存拒绝与热缓存安装。`--ignore-scripts` 的离线复验不取代常规冻结安装及构建验证。

## 验证命令

`pnpm test:development`：本轮不需要Docker的工具测试。
`pnpm test:dev-lifecycle`：真实构建应用的启动、端口冲突与取消。
`pnpm test:environment`：真实Docker/PG的独立环境、重复启动、异常清理、CLI往返等测试。

原有check/quality/browser/database/durability检查全部保留。新增测试不改变完整产品E01–E52的验收状态。工具清单见 [版本与许可](toolchain-and-licenses.md)。
