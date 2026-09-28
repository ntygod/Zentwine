# 本地工作树观察

ZT18-01-B / Issue #67，父 #63。用于团队或 Agent 接手前看清本地修改，不启动执行、不修改 index、不联网。仅在用户明确指定的可信 Linux 本地仓库运行；不对远端身份或组织权限作判断。

## 显式终端入口

先用 [A 的基线命令](local-repository.md) 取得 `snapshot.commit_sha`，再将完整 SHA 传给新入口：

```bash
node scripts/repository-worktree-inspect.mjs /absolute/path/to/repository --expected-commit <完整SHA>
```

`<完整SHA>` 是占位符；实际必须是第一次检查返回的 40/64 位小写十六进制提交 ID，不能传 HEAD、分支或简写。`--timeout-ms` 可在 1–30000 内下调。脚本仅用 Node 内置模块，无需 build；help 不读取仓库。裸仓库返回 worktree_not_applicable；linked worktree 使用自己的 index 和工作文件。

可复用方法：`await createLocalRepositoryPort(directory, options).inspectWorktree(expectedCommit, signal)`。导入入口仍是 `scripts/lib/local-repository.mjs`；旧 inspect/readFile 默认行为不变。新方法不返回正文缓冲，返回冻结的元数据报告。

## 读懂 JSON，不把退出 0 当成可以开始写代码

成功为 `status: inspected`、`scope: local_git_worktree_observation`、`authorization: false`。`snapshot` 保留精确 HEAD/分支/树，`working_tree` 提供：

| 字段 | 含义 |
|---|---|
| index_state | 同一轮 index 投影复核内采样的 Git cached 比较，亦用于 snapshot.index_state |
| entries[].index_change | none / added / modified / deleted / unmerged；稀疏目录为 not_compared |
| entries[].index_stages | 当前 index 的模式、对象 ID、stage；冲突保留多个阶段 |
| entries[].worktree.state | matches_index / modified / deleted / type_changed / not_inspected |
| entries[].worktree.reason | 未检查原因：not_in_index / unmerged_index / submodule / skip_worktree |
| untracked | 路径元数据，完全未跟踪的目录折叠为尾随 `/` 的 directory；不读正文 |
| assessment | conflicted / changes_observed / incomplete / no_changes_observed |
| coverage | partial 或 complete_for_reported_scope，不包括被明确排除的范围 |
| summary | index 差异、原始工作树差异、冲突、未跟踪、未检查项数量及实际字节读取量 |

比较对象是**原始字节及 POSIX owner executable 位**，不执行 Git 属性转换；CRLF/过滤器等可使原始字节不同，即使普通 Git status 认为一致。assume-unchanged 不阻止原始读取，skip-worktree 则明确未检查。index 的 intent-to-add 项也参与存在性比较，不伪称已经完整暂存。gitlink/子模块工作树不检查，符号链接只比较链接文本。

应用仓库 `.gitignore`、Git info/exclude；全局 excludesFile 固定关闭。忽略路径不枚举，未跟踪目录不展开，未跟踪正文不读取。不能从 no_changes_observed 推断忽略文件、子模块、其他工作树、远端或未来时刻安全。没有写租约，也没有可执行 Run。

## 失败、限额和隐私

失败为 `rejected`，snapshot/working_tree 均为 null，不返回部分清单。stale_baseline、index_changed、worktree_changed 表示观察期间的可见变化；重新确定任务基线后再检查，不能自动强制接受。目录/权限/Git/非法编码错误也失败，不打印原始 stderr、取消原因或绝对目录。

沿用 A 的每命令 2 MiB Git 输出、10000 条条目、每文件 4 MiB、30 秒总操作期限；新增聚合工作树 16 MiB 上限。options 只允许下调 timeoutMs/maxEntries/maxOutputBytes/maxBlobBytes/maxWorktreeBytes。清单计费包含 index stages、HEAD/index 路径并集和未跟踪项；超限整次拒绝，不截断冒充完整。Git 内部内存、忽略规则遍历和文件系统 I/O 不属于硬资源沙箱保证。

CLI：0=已观察（**可能有冲突或差异**）；2=拒绝；3=输出不可用；64=参数错误；124=超时；130=取消/SIGINT；143=SIGTERM。自动化须同时检查报告状态、assessment、coverage 和具体条目；任何字段都不授予写入权。

正文缓冲会清零并关闭文件描述符，输出不含工作树正文或正文摘要；index 对象 ID 与文件名是元数据，仍可能敏感。观察有界且非原子，不能替代同用户恶意竞态沙箱。原生读取也可能更新文件系统 atime，所谓只读不是磁盘无任何元数据变化。

## 验证

```bash
node --test tests/local-repository.test.mjs tests/local-worktree.test.mjs
```

完整回归仍通过原 quality CI。设计取舍见 [ADR-034](../adr/ADR-034-local-worktree-observation.md)，实现与实际测试见 [执行记录](../tasks/ZT18-01-B-execution.md)、[报告](../testing/zt18-01-b-report.md)。本增量不解除 #32/#35/PR33，不完成父 #63 的远端/权限/多库关系。
