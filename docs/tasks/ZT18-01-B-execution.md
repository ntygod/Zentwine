# ZT18-01-B 执行记录

状态：实现及本地补充验证完成；最终固定环境 CI、制品和合并状态以子 Issue #67 关联 PR 为准。父 Issue #63 保持 InProgress。

输入 main `f67308be455e944d45c3d70bfea683122395f18c`，tree `c6760f461acbc91b3117ab60f6c04151aa08afc4`，已含 #66 harness。使用 #66 engineering 制品 source.zip，经平台 ZIP 摘要、manifest 与 Git tree 核对一致；本地 Git 基线提交只用于 diff，不冒充远端提交历史。

按 harness 路由读取根、scripts、tests、docs 指引；临时工具工作流另读 .github 指引。新增工作树观察 helper、端口显式方法与独立 CLI，复用 A 的 Git/截止/取消/HEAD 复核边界，未改原 A 的默认行为和测试体。设计见 [ADR-034](../adr/ADR-034-local-worktree-observation.md)，使用见 [指南](../development/local-worktree.md)。

本地 Node 22.16.0 / Git 2.47.3：新增 50 项真实临时 Git/文件系统/子进程测试及原 45 项均通过，无失败/取消/skip/todo。覆盖冲突阶段、未暂存/暂存/未跟踪、特殊路径、稀疏 index、符号链接、原始字节/模式、限额、并发变化、中断及缓冲/描述符清理。它不是仓库固定 Node 24.21.0 的完整验收。

本地无法连接 npm/GitHub DNS。只读临时 workflow 下载现有固定 Prettier 3.6.2 的工具制品以进行本地格式核验，不修改或跳过原 format gate；最终变更树移除此工作流。完整质量、工程、数据库、浏览器、持久实验与文档仍走原 CI，结果见 [报告](../testing/zt18-01-b-report.md)及最终 PR。

无新数据库迁移、真实模型、IdP、业务部署、远端仓库写入或分支删除。#32/#35/PR33、#25/#40/#46/#63 的原未完成条件不变。回退本增量脚本与文档，不回写用户仓库内容。

补充自查：将 Git index 汇总放入同一轮 index 投影复核，新增采样时序测试；最终本地 50 新 + 45 旧 = 95/95。初次 Node 完整性检查误用了不支持的 --base 参数而未认证测试；改用既有 QUALITY_BASE_REF 后，83 个历史文件、1110 个声明保护通过，未改校验器。
