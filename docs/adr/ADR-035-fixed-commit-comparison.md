# ADR-035｜固定提交直接树比较与逐文件披露

状态：Accepted（项目授权的限定实施决定，非第三方独立审核）。日期：2026-09-28。关联：Issue #69 / 父 #63；延续 [ADR-033](ADR-033-local-git-read-port.md) 与 [ADR-034](ADR-034-local-worktree-observation.md)。

## 问题与选择

A 可读当前 HEAD 的固定正文，B 可观察未暂存状态，但团队尚不能用端口比较两次已提交交付。需要一个不隐式 checkout、不执行仓库脚本且不会默认披露全部正文的读取能力。

选择比较两个完整 commit ID 的树，复用 A 的 ls-tree 严格解析、固定 Git 子进程和总期限。默认仅产生路径与对象元数据；用户显式选择一个变更路径才读取两侧普通 blob，验证长度和 Git 对象摘要后在内存计算结构化文本差异。只接受 commit，不把 tag/tree/blob 当提交，也不从当前 HEAD 推测 base/head。

不调用外部 diff、Git textconv、clean/smudge 或工作区文件来生成正文。树按精确路径关联，重命名为删除+新增，模式变化与类型变化保留。直接树比较不等于 PR 的 merge-base 比较；反向、同树和分叉输入均明确保留调用者指定的方向。

## 文本与预算

采用确定性的逐行 LCS，保留 BOM、CR、空白、LF 与缺失末尾换行；相同分数优先删除。先剥离公共首尾再分配计算矩阵，限制两侧总行数、矩阵格数及 JSON hunk 字节。计算阶段主动让出事件循环以观察取消/期限，返回三行上下文与两侧行号。

不尝试语义重命名、语法高亮、三方合并、补丁应用或相似度推断；二进制/非 UTF-8、symlink/gitlink 返回明确未渲染原因。算法预算不足整次失败，而非截断后给出完整成功。普通文本字符串可含不可信标记，消费者必须作为数据转义显示。

## 边界与兼容

新增 compareCommits/readCommitDiff 与独立 repository-compare CLI；原 A/B 行为和旧测试保持。比较不读取 index/worktree，不要求当前 HEAD 等于输入提交，也不认为 HEAD 之后移动使已固定对象失去意义。最终仍复核仓库目录身份；同用户恶意 ABA、跨租户访问控制和硬资源沙箱由后续隔离层负责。

这只是 ZT18-01 的本地读取子增量，不提前验收 ZT18-02 的远端 PR 同步或 ZT18-04 的完整 Review/ChangeSet；不生成审批、写租约或合并授权。#32/#35/PR33 及 #25/#40/#46/#63 原关闭条件不变。

## 验证与回退

新增真实 Git、CLI、取消/期限与对象故障测试；纯 hunk 测试用固定种子重建两侧内容核验行号与间隔。完整原 CI 必须通过并核对精确源码与制品。见 [报告](../testing/zt18-01-c-report.md)。

没有迁移、冻结依赖、业务 API 或写操作。回退本次脚本和指南即可；不需修改用户仓库或恢复业务数据。

参考（2026-09-28 核对）：[Git diff-tree](https://git-scm.com/docs/git-diff-tree)、[Git cat-file](https://git-scm.com/docs/git-cat-file)、[Git diff](https://git-scm.com/docs/git-diff)。这些说明用于区分树/路径/正文语义，不代替实际目标环境测试。
