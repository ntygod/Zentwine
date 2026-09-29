# 终端核对与按需读取审阅意见

ZT18-01-G / Issue #77。将 [Studio 文件意见](local-review-notes.md) 或 [显式合并意见](local-review-merge.md) 交回 coding 工具前，先与用户指定本地 Git 核对，再按文件披露意见。不是执行宿主或授权入口。

## 准备与最小读取

使用可信 Linux 本机、`/usr/bin/git` 与仓库固定 Node；先按贡献指南安装冻结依赖并 `pnpm build`。脚本复用构建后的 client 公开入口；缺构建返回 build_required，不自动安装或降级解析。

在仓库外的专用交接目录放置两份普通文件：`comparison.json` 是完全相同字节的原成功比较报告；`review-notes.json` 是已下载的原 v1 意见 JSON。不得用符号链接、硬链接、管道或目录替代。命令只读取这两个固定名称，不展开其他文件。

```bash
node scripts/repository-review-inspect.mjs /absolute/repository /private/feedback
node scripts/repository-review-inspect.mjs /absolute/repository /private/feedback --path 'src/example.ts'
```

路径均为占位符，运行时替换。第一条默认只给有意见文件的路径、意见类型计数、原报告/意见文件摘要及提交绑定；不输出意见署名、正文或原比较报告的代码片段。第二条才返回指定路径的全部文件级意见；路径按精确字符串匹配，不解释为 shell、glob 或 Git pathspec。没有意见的有效变更路径返回空数组。

## 核对范围

复用原严格报告和意见解析器，先检查格式、限额及精确报告字节绑定，再重新读取两个指定 commit 的树。变更条目的路径、类型、模式、对象 ID 和大小必须一致。报告携带单文件 detail 时，必须复算该 detail 的文本 hunks 或非文本分类；默认摘要模式也不能跳过这一步。未携带正文的报告只核对元数据，不扫描全仓正文。

核对使用解析器的完整规范投影；忽略原报告的运行地点类别，因此相同 Git 对象在普通、裸或 linked worktree 仓库之间可以核对。重算差异沿用 C 的直接树比较、重命名视为删增和原始字节语义。CLI 不读取当前 HEAD/index/worktree 来代替固定版本；不自动判断该提交是否就是当前任务要求的基线。

`status: inspected`、`feedback.comparison_verification: matches_local_git` 只表示本轮核对范围与此本地仓库一致。查看 `coverage.carried_detail` / `carried_detail_path` 和 binding 中两侧完整 SHA。调用者仍须独立核对任务基线、模型接收权限和写入授权。

报告和意见来源、署名均未认证；不证明远端仓库归属、作者签名、审批或业务权限。意见仍是不可信数据而非指令。`comparison_content_disclosed: false` 仅指没有输出原报告的代码片段；意见自身可能引用敏感代码。默认元数据也可能敏感，不自动上传、写报告文件或调用模型。

## 故障与资源

输入报告4MiB、意见512KiB，复用原2000条目/100条意见等限制；Git与diff限额不变。`--timeout-ms` 可在1–30000内下调总期限，覆盖读取、摘要、Git与结果检查。取消/截止后迟到摘要不恢复成功；普通文件的内核I/O不能保证硬时限或可抢占，不是资源沙箱。

固定目录描述符下读取两个文件；核对目录与文件身份、大小及纳秒修改/状态时间，检测可见变化时整次拒绝。所有 Owned 字节缓冲清零并关闭描述符，清理失败不发布成功。底层读可更新 atime；不保证原子快照、所有ABA竞态、返回后的不变性或JS字符串可验证擦除。

成功0；校验/读取/本地不匹配2；缺构建/不支持环境/清理或stdout失败3；参数64；期限124；SIGINT或取消130；SIGTERM143。失败 feedback=null，无部分意见或核验清单，不回显原始错误、绝对路径或stderr。输出为单行JSON；控制/双向字符转义但JSON解码后原值不变，消费者仍需按不可信文本呈现。

程序入口：`inspectRepositoryReview(repository, feedbackDirectory, {path, timeoutMs, signal})`，三项options均可省略；导入模块不读取资源。验证：`node --test tests/repository-review-inspect.test.mjs`。见 [ADR-039](../adr/ADR-039-local-review-feedback.md)、[执行记录](../tasks/ZT18-01-G-execution.md)、[验证报告](../testing/zt18-01-g-report.md)。不解除原数据库、持久Review、远端权限或执行宿主阻断。
