# 文件审阅意见与本地交接

ZT18-01-E / Issue #73。先按 [Studio比较报告](studio-code-review.md) 导入原CLI成功JSON，再选择一个变更文件。该功能仅操作当前窗口内存和显式下载，不写仓库或远端PR。

## 写下并交接意见

在「文件审阅意见交接」中填入自填署名、问题/建议/疑问和正文，点击「添加文件意见」。每条明确绑定文件路径，不绑定代码行。没有携带正文的文件也能写文件级意见；这不表示已看过全部代码。切换文件会清空尚未添加的草稿，已经添加的意见仍在当前意见集。

点击「准备意见交接文件」，再点击「下载审阅意见 JSON」才保存到浏览器下载位置。准备文件并不等于下载已完成；未添加草稿不包含在文件中。原比较报告不自动附带，需连同意见文件另行交接。意见本身可能引用敏感代码，下载和发送前检查接收者权限。

接收者先导入**完全相同字节**的原比较报告，再选择意见JSON并点击「导入文件意见」。SHA-256、对象格式、两侧commit/tree与所有意见路径都检查匹配；重新格式化、换行或改正文即使保留相同提交SHA也会拒绝。意见JSON自身可以重新排版，不影响其内容绑定。

已有意见时不能导入覆盖或自动合并；请先下载并确认文件可用，再「清除全部意见」，然后导入新的意见集。导入时清空未添加草稿。通过导入得到的署名、ID和意见仍为未认证声明，任何人都可能伪造；摘要只能防止意外错配，不证明作者或意见真实性，也不是批准。

## 生命周期与限制

替换/清除比较报告、关闭审阅、切换回交接包检查台、刷新和离开页面会丢失未导出意见。不写localStorage、sessionStorage、IndexedDB或cookie，不上传。下载URL在意见集修改、清除或卸载后撤销；已下载的磁盘文件不会被删除。

意见文件最多512 KiB、100条，正文最多4000 UTF-8字节、署名最多120字节；文件列表每页10条。输入框字符限额是辅助，最终以UTF-8字节为准。整体标准导出也须在512 KiB内（转义/路径占空间）；超限新增保留旧意见并报错。重复ID、重复键、未知字段/版本、不匹配源报告或路径、无效Unicode均整份拒绝。

读取10秒超时；可以取消。取消/清除/卸载隔离迟到结果，错误不回显文件内容。正文以纯文本显示，控制/双向字符可见转义。缺少Web Crypto的浏览器上下文会拒绝建立意见会话；使用项目本机localhost Studio或适当的安全上下文，不降级到无哈希绑定。Owned字节清零不代表JS字符串或浏览器副本可验证擦除。

## 程序接口与验证

client公开 `createRepositoryReviewSession(originalJson)`、`validateRepositoryReviewNotes(session, notes)`、`serializeRepositoryReviewNotes(session, notes)`、`parseRepositoryReviewNotes(session, notesJson)`。会话由原报告解析和摘要函数创建，不能以手工拼接会话替代。所有接口不调用Git/HTTP/模型，不提供执行权限。原报告解析器独立入口保持兼容。

构建后：`node --test tests/repository-review-notes.test.mjs`；浏览器：`pnpm exec playwright test tests/browser/repository-review-notes.spec.ts`。完整回归仍按 [验证路由](../harness/verification.md)。设计见 [ADR-037](../adr/ADR-037-local-review-notes.md)，结果见 [执行记录](../tasks/ZT18-01-E-execution.md) 与 [报告](../testing/zt18-01-e-report.md)。

这不是服务器持久Review、PR同步、行级评论、真实签名或多作者自动合并；#32/#35/PR33及原父任务范围保持。

## 汇总多份意见

另有[显式预览合并](local-review-merge.md)入口，可保留当前意见再逐份预览、处理冲突并确认。原空集导入行为和v1交接格式不变，不自动覆盖或合并。

## 交回 coding 工具

从 [终端核对与按需读取](local-review-feedback.md) 先与指定本地Git核对原报告，再按文件读取意见。内容一致仍不代表作者认证或执行权限。
