# ZT18-01-C 验收记录

范围：Issue #69；基线 main `c2fa64ebddbe4a84e9a51b6844e3158abc25eb36`，源码树 `f1bcdddb33ba138fa7c8fb60bd61cd39b8570102`。这不是完整远端 Review、版本持久化或模型交付验收。

## 本地补充验证

环境 Linux / Node22.16.0 / Git2.47.3 / Python3.13.5。源树由已核对 PR #68 工程制品恢复，git write-tree 与上述远端树一致；临时本地 commit 仅作源码比较，不冒充远端 Git 历史。

新增 `tests/local-commit-comparison.test.mjs` 59项通过；原 A/B 的95项保持。新增覆盖：双完整 SHA、历史/同树/反向/分叉、SHA256、bare/linked worktree、未出生 HEAD、暂存/未暂存隔离、重命名、模式/类型、gitlink/symlink、特殊路径、空文件、BOM/CRLF/末尾换行、二进制/无效UTF8、所有新增预算、Git输出/并集限额、取消/期限/CLI信号、损坏摘要、根目录替换与缓冲清零。

纯算法测试以固定种子生成150组重复行/插入/删除/换行组合，从 hunk 重建目标文本，并检查两侧行号与未展示区间；另验证远距离 hunk、公共首尾预算和 JSON 转义字节边界。该150组属于已有测试体内部样本，不另计为150条独立测试。借用缓冲清理使用明确合成宿主响应，不冒充真实Git行为；主要端口与CLI使用真实临时Git。

开发时首轮新增52项通过，随后补齐7项识别/退出码/清理测试并再次通过59项；原95项在共享树解析重构后通过。未删除失败断言或以新结果改写历史套件。三份 Git 套件一起最终复验 **154/154**，0失败/取消/skip/todo；最终提交CI结果由关联PR记录精确绑定。

本地包边界、固定格式、harness17指南/12入口、53项harness维护测试、213份Markdown/30模块/180任务/52场景及8契约schema均通过；凭据扫描575文件、历史84个JS/TS文件1159测试声明与4个Python文件保护、8项迁移静态、5个workflow政策和diff空白检查通过。历史测试保护基于上述同树的临时本地commit，远端真实base在CI再次核对。

固定 Prettier3.6.2 来自上一轮工具制品10971808976，已核对 ZIP SHA256 `f83df50da096caec5cb1adc9a2017597b2f0de5ad7c02b4c2beff96a60641efc` 与 npm tarball SRI/冻结锁一致。本地包边界/测试体保护若使用现有 TypeScript5.8.3，只算补充，不能代替固定目标CI。

## 目标环境 CI 与制品

原 quality workflow 必须执行全部六任务：policy、engineering、database、durability、documentation、quality-gate。最终 head/candidate/base/tree、run/attempt、各测试实际数量、五组制品ID/摘要及源码核对以 Issue #69 关联 PR 验收评论记录。没有精确成功证据不得合并；本地 Node22 不替代 Node24 的完整回归。

## 未验收与回退

未增加浏览器审阅UI、远端身份/权限/多库绑定、持久 ChangeSet/Review、批准或合并执行。二进制/非普通对象不展示正文；文本hunk不是Git patch。默认不披露正文，显式逐文件输出仍可能敏感，不提供字符串或stdout安全擦除保证。

原 #32/#35/PR33、#25/#40/#46/#63 与远端分支删除待办保留。没有业务库迁移、生产部署、付费服务或模型调用。正常 revert 本增量即可，无用户仓库写入需要撤销。
