# 2026-09-28 仓库整理记录

## 基线与保留范围

整理起点 main `7f3645482ba338aab96292198e15f7079e1bcf8a`，最新业务 PR #65。原始 34 条分支，另建本次 chore/repository-harness。32 条历史分支均满足当前 SHA 等于已合并 PR head、不是开放 PR 的 head/base、未标记 protected，且全量 Git 祖先检查确认已包含在起点 main。

完整名称、SHA、PR、合并时间与合并提交见 [候选清单](branch-cleanup-2026-09-28.json)。依据是只读 [inventory run](https://github.com/ntygod/Zentwine/actions/runs/36419945655) / job108919973624；制品10969057582及 SHA-256 见清单，已校验 ZIP 与内部文件摘要，源码树 fa97094ca7fce292288ad38b2cd5a63861e486fe 与 Git tree 一致。临时 inventory workflow 只为此次审计，在最终变更中删除。

**远端删除未执行。** 当前连接没有删除 ref 接口；仓库明确禁止 write 权限 CI，不新增写权限流程、不放宽门禁、不复用其他权限渠道。保留 main、未合并的 feat/ZT03-02-version-cas（Draft PR #33）和本次工作分支。可在具备权限的可信本机按 [维护流程](README.md) 显式执行经过复核的删除。

## 文档与 Harness

根 README/AGENTS 改为最短入口，按任务路径逐级加载 17 份 AGENTS；文档首页按问题路由。补齐已有开发指南、计划/模块、ADR、执行与验证报告索引。没有将终态蓝图缩减，也没有搬走现有指南/报告或修改历史失败证据。

当前状态入口与历史过程分离：[整理前快照](../tasks/history/2026-09-28-status.md) 以不可变 Git 链接保存原 status 的字节及相对链接，不重复复制长流水。当前页核实 A8 与本地 Git 子增量已合并，保留 #25/#32/#35/#40/#46/#63 与 Draft PR #33 的未完成边界；不用整理来关闭业务任务。

harness 标准库脚本只做目录路由、结构/预算/链接/索引检查；维护工具默认 dry-run。新增正反例进入原 quality 测试与 documentation job；不修改原迁移扫描器、历史迁移、旧测试体、冻结依赖或必需 CI 集合。

## 验证与回退

本地补充验证与最终固定环境 CI、精确 head/制品应以本次整理 PR 为准；不要把本记录当成其未来 CI 自动通过声明。harness 测试不会运行真实 Agent/付费模型，维护测试不会删除 GitHub 分支。

文档/脚本可通过正常 revert 回退；原历史文件和完整规划路径保留。分支删除若以后执行，应追加实际回执；恢复用候选完整 SHA，不覆盖他人的新同名分支。此轮不迁移业务库、不部署生产、不修复或合并 PR #33。
