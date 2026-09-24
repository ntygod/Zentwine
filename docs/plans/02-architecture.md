# 02｜架构与仓库落点

## 1. 推荐技术基线（待 ADR 评审）

采用 TypeScript 为主的 pnpm monorepo；React 构建 Workbench 与 Studio，Monaco 作为原生代码编辑器候选。后端使用 Node.js 当前经测试 LTS 与 Fastify 模块化服务。PostgreSQL 是业务和版本权威库，S3 兼容对象存储承载产物。Temporal 是持久工作流候选，Redis 只用于缓存、速率与实时分发，不作最终业务状态来源。

桌面客户端候选 Electron，复用 Studio；启动本地 Runner 的权限与浏览器页面隔离。版本号不在规划中伪造“最新”，由 ZT01-01 选取当时受支持稳定版本并写入锁文件和兼容矩阵。供应商基座被包在自有 RuntimeAdapter 后，前端不直接依赖供应商 SDK。

这些是为了降低并行开发歧义给出的默认建议，不表示负责人已批准。偏离须新增 ADR，不允许每位 Agent 自选互不兼容的框架。

## 2. 拟建目录

```text
apps/
  workbench/            # 管理、原生业务、门户路由
  studio/               # 独立 Coding Web 入口
  desktop/              # Studio 桌面宿主
services/
  api/                   # HTTP/WS 鉴权、领域命令、查询
  orchestrator/          # 持久流程与调度 Worker
  runner/                # 环境、进程、工作区与适配器宿主
  verifier/              # 独立可信验证与证据签发
packages/
  domain/                # 纯领域规则与状态机
  contracts/             # API、事件、运行时和产物 schema
  db/                    # migrations、租户隔离和 repository
  ui/                    # tokens、组件、可访问性
  client/                # 类型化 API 与事件客户端
  policy/                # 授权决策，默认拒绝
  runtime-core/          # RuntimeAdapter 接口与契约测试
  runtime-claude/        # Claude Agent SDK 适配
  runtime-codex/          # Codex 适配
  connectors/            # 代码、设计、任务、监控等供应商端口
  telemetry/             # trace、metrics、redaction
  testkit/               # FakeRuntime、固定时钟、Fixture
infra/                   # Compose、部署、恢复与配置
scripts/                 # 文档和契约校验，开发工具
```

本图是预期落点，不声称目录已经存在。modules 文档中的路径都相对此图。

## 3. 服务边界

业务内核可先一个部署单元，领域之间通过命令和明确接口访问，不直接改对方数据表。Runner 和 Verifier 从开始就与业务 API 分进程/安全域；不可信仓库代码不能在控制面进程执行。

PostgreSQL 决定已批准规格、授权、任务和账本的当前状态。Temporal 保存流程控制历史；Worker 通过带幂等键的领域命令申请转换，不直接把引擎状态当成业务审批。事务 outbox 驱动外部调度，结果事件更新领域投影；启动超时按 workflow_id 对账，不创建第二条重复流程。

Artifacts 存储不可变版本与摘要；业务库只存引用和访问策略。供应商会话 ID、文件路径和云实例 ID 不是可公开的授权凭据。

## 4. 两套 UI 的连接

`/org/:org/workbench/...` 与 `/org/:org/studio/workspaces/:workspaceId` 是不同布局但共享身份、领域 ID 和事件协议。打开 GET 路由只读，不创建 Run。需要启动时调用显式命令，携带幂等键和授权。桌面深链只携带定位信息，重新鉴权后换取短期连接凭据。

事件由后端分发，跨窗口 BroadcastChannel 只能加速界面通知，不能作为状态权威或执行锁。

## 5. 执行安全边界

控制面通过出站连接或受控网关与 Runner 通信；浏览器不直连原始供应商 App Server。Runner 以每执行的只读基线、可写卷、网络规则和配额创建环境。单租户开发环境可以用容器；跨租户不可信代码必须通过威胁模型验证的强隔离方案。只使用 worktree 不能通过安全验收。[S06]

Verifier 无开发 Agent 的自批权限，使用保护的验证配置。Git 写入、PR、合并、部署经凭据代理或工具网关执行；生产凭据不进入开发上下文。

## 6. 扩展与部署

连接器区分外部权威字段与平台字段；缓存携带 source_version 与 sync_status。支持原生仓库、外部 Git、多仓库、单体仓库。私有化、专属云、离线兼容模型是终态，但离线模式不伪装支持云专有模型。

审计和日志事件先于高级报表建设；多区域默认一个业务主写入区域和明确故障转移，不默认无冲突多主。

## 7. 需要验证的架构事项

ADR-001 工程与编排选型；ADR-002 权威来源及版本；ADR-003 Studio 写入控制；ADR-004 供应商兼容；ADR-005 独立验证；ADR-006 扩展和自治安全。每项有基准实验、拒绝条件和回退路径，详见 ADR 目录及资料索引。
