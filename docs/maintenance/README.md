# 仓库维护

维护不改业务验收状态，不清除失败历史，不借 CI 或 Agent 提示词扩大账户权限。

## 本轮记录

[2026-09-28 整理记录](2026-09-28-repository-cleanup.md) 包含原始基线、文档迁移和执行边界；[分支候选清单](branch-cleanup-2026-09-28.json) 固定 32 个已核对的 HEAD/PR。**远端删除尚未执行**，清单是当时快照，不是长期删除许可或回执。

## 分支生命周期

默认分支、受保护分支、开放 PR 的 head/base 与未合并工作必须保留。只有当前 HEAD 对应已合并 PR 且仍是最新 main 的祖先，才进入本轮候选。名字旧、PR Closed 或分支 Behind 都不是充分条件；squash/rebase 后非祖先的历史需另行审查，此工具不会猜测等价。

维护者在已安装 Git 与已授权 GitHub CLI 的可信本机，从仓库根目录运行：

```bash
pnpm branches:audit
```

默认只读 GitHub 元数据，临时裸仓库 fetch 并核验祖先，不改变用户工作树、本地分支或远端。需要 `gh api` 读取权限，公开仓库 fetch；不自动安装/登录/配置凭据。stdout 是 JSON，应保存本次结果而不是覆盖原始清单。

审核 dry-run 结果后，显式删除入口：

```bash
python3 scripts/maintenance/branches.py --apply --confirm ntygod/Zentwine
```

此命令会删除清单中仍符合条件的远端分支，请只在有该仓库删除权限且确认无并行维护时运行。应用前重新回读完整元数据；逐 ref 使用精确 SHA 的 force-with-lease，并以 atomic push 一起删除。任一候选新增提交/受保护/开放 PR 引用/合并证据变化则阻止整批应用。服务器不支持 atomic 或拒绝权限时失败，不降级到无条件删除。

Git ref lease 可拒绝并发 HEAD 变化，但 PR/默认分支元数据与 Git push 不是一个原子事务：最后回读后仍可能新开 PR 或改变保护。请选择无并行维护窗口，保留服务器规则；不要把脚本当成跨系统锁。应用异常输出 unknown 时必须重新核对远端，不能盲目重试并宣称未删除。已经不存在的候选仅标为 already_absent，不归功于本次操作。

## 回执与恢复

成功后脚本再核对远端 ref 消失，才填 deleted_verified；将输出、执行时间与实际保留分支记录到新的维护记录，不重写原始审计快照。清单保存全部完整 SHA，且已核对其仍可由 main 追溯；需要恢复时从该 SHA 新建同名分支，先确认名字未被其他工作占用，不覆盖新引用。

此工具不删除 tags、PR、Issue、提交历史、工作树或其他仓库，也不设置仓库自动删分支/保护规则。后续新分支需新清单和同样核验，不自动扩大这份清单。

语义依据：[Git push 的 atomic 与显式 lease](https://git-scm.com/docs/git-push)。局部测试使用临时裸仓库，不等于已经删除 GitHub 远端分支。
