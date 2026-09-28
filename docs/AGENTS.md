# 文档维护

## 适用范围

继承 [根约定](../AGENTS.md)。先看 [文档导航](README.md)，只打开本次需要的指南与任务。

## 唯一归属

当前状态放 tasks/status；操作步骤放 development；设计理由放 adr；目标范围放 plans/modules；执行过程放 tasks；验证事实放 testing。入口文档只做导航，不复制全文。

终态规划、已合并限定增量和真实生产能力分开。变更状态先核对 live PR/Issue/head；历史报告是当时证据，不改失败记录以伪造成功。长状态流水归档并保留链接，不能删除未完成项。

原文档 URL 尽量保持；移动时修复相对链接并留迁移入口。docs/modules 固定 30 个模块文件，不能在此目录新加 README 或 AGENTS 来破坏规划计数；它继承本约定。180 任务与 E01–E52 验收规划不因整理缩水。

## 验证

运行 `pnpm docs:check`、`pnpm harness:check`、`pnpm test:harness`；schema 还用 `python3 scripts/validate_plans.py --validate-schemas`。新增指南/ADR/执行/报告必须进相应索引；按需资料不要全部塞进根 AGENTS。

篇幅/作用域维护见 [Harness](harness/README.md)，文档通过不代替产品验收。
