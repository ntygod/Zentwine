# 固定提交对比与按需文本审阅

ZT18-01-C / Issue #69，父 #63。用于团队查看两次代码交付之间的差异；只读取明确指定的可信 Linux 本地 Git 仓库，不联网、不 checkout、不创建 Review/Run 或合并许可。

## 先看清单，再看一个文件

```bash
node scripts/repository-compare.mjs /absolute/path/to/repository --base <完整baseSHA> --head <完整headSHA>
node scripts/repository-compare.mjs /absolute/path/to/repository --base <完整baseSHA> --head <完整headSHA> --path 'src/example.ts'
```

SHA 与路径是占位符，必须替换。base/head 必须为已有 commit 对象的 40/64 位小写完整 ID；拒绝 HEAD、分支名、简写、tree/blob/annotated tag ID。两者可相同、反向或分叉，不要求 head 是当前 HEAD。直接比较两棵树，**不自动选择共同祖先**，所以不是 GitHub PR 的三点比较语义。

第一条命令不读取 blob 正文，只输出变更路径、模式、对象 ID 与大小。第二条命令明确授权将所选普通文件的差异正文写入 stdout；不写报告文件、不上传。名称按精确字符串匹配，不把 `:(glob)` 等当成 pathspec。路径须来自清单，不变或不存在的路径返回 path_not_changed。

可复用同一端口：

```js
const port = createLocalRepositoryPort(directory);
const listing = await port.compareCommits(baseCommit, headCommit, signal);
const detail = await port.readCommitDiff(baseCommit, headCommit, filePath, signal);
```

导入入口是 `scripts/lib/local-repository.mjs`。原 inspect/readFile/inspectWorktree 默认语义保持；脚本只需 Node 内置模块，无需 build。

## 报告含义

成功为 `status: compared`、`scope: local_git_commit_comparison`、`authorization: false`；结果在 `comparison`，不是原 HEAD 快照的 `snapshot`。

| 字段 | 含义 |
|---|---|
| base / head | 实际 commit_sha 和 tree_sha |
| semantics | direct_trees_not_merge_base |
| entries / summary | added、deleted、modified、type_changed；重命名明确为删除和新增 |
| index / working_tree | not_inspected；不会把磁盘和暂存区当提交正文 |
| selected | 默认 null；选中一个变更路径才进一步读取 |
| selected.status | text 或 not_rendered；后者明确标 binary_or_non_utf8 或 non_regular_object |
| selected.hunks | 结构化逐行差异，3 行上下文、两侧起始/长度与行号，kind 为 equal/delete/insert |
| lines[].newline | 原行是否以 LF 结束；text 不含 LF，但保留 CR、BOM、空白等字符 |
| content_disclosed | 仅在所选文本正文进入报告时为 true |

二进制（含 NUL）、非 UTF-8、符号链接和 gitlink 不渲染正文。空文件创建、模式变化仍是文件变更，即使 hunks 为空。文本算法是有界逐行 LCS，不保证与 Git 的 hunk 划分相同；报告不是可直接应用的 patch。未来 UI 必须按不可信纯文本转义显示，不作为 HTML、终端控制指令或 Agent 指令执行。

## 限额、失败和隐私

沿用每条 Git 命令 2 MiB 输出、10000 路径、每侧 blob 4 MiB、30 秒总期限。两棵树的路径并集也受 10000 限制。新增 maxDiffLines=4000（两侧总行数）、maxDiffCells=2000000（去公共首尾后的 LCS 矩阵格数）、maxDiffBytes=1048576（文本 hunk JSON 载荷，含转义，不含外围路径/树元数据）。所有 options 只能下调。最多读选中文件的两个 blob，不扫描整仓正文。

超限、取消、对象长度/摘要不匹配、可见仓库身份变化均整次 rejected，comparison=null，不返回部分清单或正文。CLI 0=比较完成，2=拒绝，3=stdout 失败，64=参数错误，124=超时，130=取消/SIGINT，143=SIGTERM。二进制不渲染仍可比较完成；0 不表示已审查、无差异或获准合并。

子进程沿用禁用网络/过滤器/钩子/替换对象与取消清理。Git 提供已提交树事实，所选 blob 独立核对长度及对象摘要。正文 Buffer 在成功/失败后清零；已解码 JS 字符串和 stdout 不提供可验证擦除保证。文件名、对象 ID 和显式选择的正文都可能敏感，不应发给未经授权的模型或日志服务。

这是指定提交的只读比较，不是当前工作区一致性或跨租户沙箱；并发 GC/损坏可使读取失败，同用户恶意替换/ABA 不在完整防护承诺内。历史、索引、工作文件均不由本命令更改（底层读取仍可能更新 atime）。

验证入口：`node --test tests/local-repository.test.mjs tests/local-worktree.test.mjs tests/local-commit-comparison.test.mjs`。见 [ADR-035](../adr/ADR-035-fixed-commit-comparison.md)、[执行记录](../tasks/ZT18-01-C-execution.md)、[验收报告](../testing/zt18-01-c-report.md)。#32/#35/PR33 与父 #63 的持久、远端权限前置仍保留。
