# ADR-034｜本地工作树采用原始字节观察，不授予写入权

状态：Accepted（项目已授权的限定实施决定，非独立第三方审核）。日期：2026-09-28。关联：Issue #67、父 #63；延续 [ADR-033](ADR-033-local-git-read-port.md)。

## 问题与选择

A 的 index-only 检查不会发现未暂存文件。团队接手同一代码库需要区分 HEAD、index 和当前磁盘内容，但不能因为读取仓库而执行其过滤器或脚本，也不能绕过版本持久化和工作区租约前置。

直接调用完整 porcelain status 虽然符合 Git 用户习惯，却不满足本增量“不执行 clean/textconv/外部进程”的边界；仅查看 stat 又可能漏掉内容差异。选择复用 A 的固定 Git 子进程边界，由 `ls-files --stage -v -z --sparse` 读取 index 阶段/模式/对象/标志，另以 `ls-files --others --exclude-standard --directory` 枚举未跟踪路径。只对可检查的 index 普通文件和符号链接原始目标字节计算 Git blob 摘要。

## 明确语义

新增 `inspectWorktree(expectedCommit, signal)` 和独立 CLI。旧 `inspect/readFile` 的报告 scope、行为和默认不读工作树语义不变。新 scope 为 `local_git_worktree_observation`，不发布为服务端 RepositoryBinding。

原始字节/owner executable 位与 index 比较，不做 CRLF、编码、LFS 或 clean/smudge 转换，不声称与 `git status` 等价。index 项与 HEAD 比较也包含 intent-to-add，不伪装成 porcelain 的暂存语义。重命名呈现为删除与新增；冲突保留 stage 1/2/3，不读取冲突正文。稀疏目录不展开且不误报其 HEAD 子项被删除；skip-worktree、gitlink 明确未检查。

不输出全局 clean、可写或已授权状态。成功报告仍可能是 conflicted、changes_observed 或 incomplete；no_changes_observed 仅表示本次声明范围内没有观察到差异。未跟踪目录折叠，忽略文件不列出，用户全局 exclude 被固定环境禁用。文件名也可能敏感，调用方须管理可见性。

## 读取与竞态

Linux 下通过 `/proc/self/fd` 锚定已打开的父目录，各级以 O_DIRECTORY/O_NOFOLLOW 打开；叶文件 O_NOFOLLOW/O_NONBLOCK，读取前后 fstat 与 lstat 一致。符号链接只读链接文本，不跟随目标；FIFO/设备/目录类型变化只报告，不读正文。读取缓冲在成功、失败、取消后清零并关闭描述符。

共享总期限、Git 输出上限和进程组取消清理。普通文件限额沿用 maxBlobBytes，新增可下调的 maxWorktreeBytes 默认 16 MiB 聚合预算。观察末尾复读 index 元数据、未跟踪列表和已采样路径身份/时间戳，再由 A 复核 HEAD/分支/根目录身份；变化整次拒绝，无部分成功。

重复检查不是原子文件系统快照，不能排除所有 ABA、返回后的变更、恶意同用户竞争或内核不可中断等待。Git 仍解析本地配置与忽略文件；此工具不是跨租户恶意仓库沙箱，不代替权限、写租约、独立进程资源限制或持久验收。

## 验证、兼容与回退

新增真实临时 Git/文件系统/CLI 测试，保留 A 的全部旧测试体；具体执行结果见 [报告](../testing/zt18-01-b-report.md)。完整 CI 与精确合并后才关闭子任务；#32/#35/PR33、#25/#40/#46/#63 保留原条件。

无数据库迁移、依赖或公开业务 API 变化。回退本增量的脚本及文档即可恢复 A；不需要回写任何用户仓库数据。未来需要 Git 规范化状态或实际写入时，应单独设计可信执行隔离、权限和租约，而不是放宽这里的读取边界。

参考：[Git ls-files](https://git-scm.com/docs/git-ls-files)、[Git status](https://git-scm.com/docs/git-status)、[Node FileHandle](https://nodejs.org/api/fs.html)。文档语义不替代本仓库实际环境验证。
