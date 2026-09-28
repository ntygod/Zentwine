# ZT18-01-B 验证报告

范围：Issue #67 的本地工作树原始观察；非 Git porcelain 等价实现、跨租户沙箱、远端权限、写租约、真实模型或生产验收。输入主线 `f67308be455e944d45c3d70bfea683122395f18c`。

## 本地实际执行

环境：Linux、Node 22.16.0、Git 2.47.3、Python 3.13.5。代码只用 Node 内置模块，原始测试执行无冻结依赖替代或假 Git 包。

`node --test tests/local-repository.test.mjs tests/local-worktree.test.mjs`：95/95，通过包括原45与新增50；0失败、0取消、0跳过、0todo。首批39新增实际通过后，增加10项中断/错误/缓冲测试，再重新执行全部94；自查 index 汇总采样时序后再增1项，最终全部95重新通过，不沿用旧运行结果。

| 分组 | 实际覆盖 |
|---|---|
| 语义 | 未暂存、暂存后继续编辑、新增/删除、冲突stage、重命名分解、intent-to-add、原API不变 |
| 原始比较 | SHA1/SHA256、二进制、CRLF、owner执行位、assume-unchanged、无属性转换 |
| 覆盖边界 | skip-worktree、实际sparse-index、gitlink、ignored、未跟踪目录折叠、特殊文件名 |
| 无越界读取 | 符号链接叶/祖先、FIFO、Git管理路径拒绝；链接目标/未跟踪正文不输出 |
| 无副作用 | clean/smudge/process/textconv/extdiff/fsmonitor/hooks不执行；index/config/HEAD/reflog字节不变 |
| 限额与失败 | 文件/聚合字节、合并条目预算、错误UTF8、非法/重复index输出、裸库/错误基线 |
| 竞态与清理 | index标志/HEAD/文件/父目录/未跟踪变化；超时/取消、真实CLI SIGINT/SIGTERM、描述符关闭与缓冲清零 |

## 完整验收归属

固定 Node/pnpm/冻结锁、原完整 CI、精确 head/candidate/tree、五组制品及合并回读结果记录在 Issue #67 对应最终 PR。未获得全部成功证据前不关闭子任务，不把此本地报告算为完整通过。

测试故障注入明确用真实临时仓库配合替换子进程输出或暂停进程，验证拒绝路径；不是实际供应商联调。原测试体、历史迁移、质量校验器、锁文件与所有必需 CI job 保持。主线合并只用于限定本地增量，不解除 #32/#35/PR33 的数据库阻断。

补充检查：固定 Prettier 3.6.2（工具归档已核验其 SRI 与冻结锁一致）、包边界、17份指南/12入口 harness、30模块/180任务/52场景/209份Markdown/8份契约JSON文档校验、53项 harness/维护测试、凭据/工作流/8项迁移静态检查通过。历史测试保护实际为83个JS/TS文件、1110个声明及4个Python文件；本地完整性命令首次参数使用错误后已以 QUALITY_BASE_REF 重新核验通过。工具准备 CI 只提供格式化工具，不是产品验收。
