# ZT18｜原生/外部仓库、代码评审与跨库集成

状态：Planned。负责人职责：平台、后端、开发工具、安全。依赖模块：ZT02、ZT03。对应蓝图：09、18.4。

## 范围

支持原生托管或外部 Git、单体仓库/多仓库、分支策略、Code Owners、变更集、PR/MR、评审、组合候选、发布分支和补丁回移。原生体验不要求自研 Git 对象协议，可用经过评估的 Git 服务并置于统一 RepositoryPort 后。

## 数据与接口

RepositoryBinding(provider,external_id,authority)、RepositoryPolicy、RefMirror、ChangeSet(commits,work_packages)、Review、PullRequestMirror、IntegrationCandidate(repo_commit_map)、MergeOperation。

`/repositories`、`/changesets`、`/pull-requests`、`/integration-candidates`、`/merges`。外部权威状态回读后确认；webhook 验签去重，状态同步失败明确标 degraded。[S08]

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT18-01 | ZT02-02、ZT03-02 | 实现 RepositoryPort、外部仓库连接、文件/ref 只读、权限和远端标识 | 一项目可多库、一库可多项目；私库查询不越权；链接与 SHA 明确 |
| ZT18-02 | ZT18-01 | 接入 PR/MR、评论、评审、checks、webhook 与定期对账 | 重复 webhook 不重复状态/消息；漏事件可回读补齐；未知结果不盲写 |
| ZT18-03 | ZT18-01 | 实现原生托管管理：仓库生命周期、Git 认证、LFS/配额、hooks 隔离和备份 | clone/push 权限正确；恶意 hook 不进控制面；仓库与 LFS 可恢复和导出 |
| ZT18-04 | ZT18-02、ZT18-03 | 实现 ChangeSet、需求/验收关联、差异评审、代码所有权和保护分支策略 | Agent 不能自行通过自己的必要评审；新提交让相关批准过期 |
| ZT18-05 | ZT18-04 | 实现组合候选、多仓库清单、合并排队、基线复查和兼容窗口 | 单分支通过不等于组合通过；目标分支移动后重核，不能以旧测试合并 |
| ZT18-06 | ZT18-05 | 完成迁移、补丁回移、同步故障和代码工作台联调测试 | 仓库更换/归档可追踪；跨库失败记录部分完成和补偿，不声称原子发布 |

## 测试和边界

对外部平台权限能力做探测，无法配置保护时显示缺口，不伪装已保护。测试 API 超时但 PR 已创建、base 变动、删除分支、权限撤销、LFS 丢失和原生存储损坏。

运行中的文件编辑由 ZT15/17 负责；本模块掌管 Git/评审事实。控制台不保留 Git 全权限 token，合并需独立授权，生产部署交给 ZT20。
