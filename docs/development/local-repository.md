# 本地 Git 只读基线

ZT18-01-A / Issue #64，父 Issue #63。此端口接入本机已有 Git 仓库，不连接远端或授予组织权限。参考环境为 Linux、可信 `/usr/bin/git`；Windows/macOS 未验收且入口拒绝，不能据此宣传跨平台支持。

## 终端入口

在 Zentwine 仓库根目录运行（这两个新脚本仅使用 Node 内置模块，无需构建产物）：

```bash
node scripts/repository-inspect.mjs /absolute/path/to/repository
node scripts/repository-inspect.mjs /absolute/path/to/repository --file README.md --expected-commit <完整提交SHA>
```

先检查第一次 JSON 的 `status === "inspected"`，将 `snapshot.commit_sha` 原样用于第二次命令；尖括号内容是占位符，不是命令字面量。指定路径必须是工作树根目录或裸仓库根目录，不自动从子目录向上接管父仓库。末级符号链接根目录（含尾随斜杠）拒绝；祖先路径按本机用户输入解析，不是目录沙箱。支持 linked worktree。

`--file` 与 `--expected-commit` 必须同时给出；不接受 HEAD、分支名或简写 SHA 作为预期提交。路径只用来在已读取清单中查找，永不拼接 shell 命令、Git revision 表达式或文件系统读取路径。换行、Tab、中文、冒号和前导短横线文件名按 NUL 分隔清单识别，输出 JSON 转义；不支持非 UTF-8 的 Git 文件名，遇到时整次拒绝而不替换字符。

默认只读 HEAD 指向的提交树元数据，不读取全部文件正文。指定文件时从清单对象 ID 读取原始提交 blob，并核对长度、Git 对象摘要和原始内容 SHA-256；CLI 随后清除其收到的字节缓冲，只输出元数据，不把文件内容写向 stdout。Git LFS 指针仍是原始 blob，不自动取得 LFS 内容；符号链接与 gitlink 仅列出，不跟随或读取其目标。没有 checkout、fetch、clone、push 或远端身份探测。

## 可复用端口

```js
import { createLocalRepositoryPort } from "./scripts/lib/local-repository.mjs";
const port = createLocalRepositoryPort(repositoryDirectory);
const baseline = await port.inspect(abortSignal);
if (baseline.status !== "inspected") throw new Error("repository unavailable");
const result = await port.readFile(baseline.snapshot.commit_sha, "README.md", abortSignal);
if (result.report.status !== "inspected") throw new Error("pinned read rejected");
// result.bytes 是经过长度和 Git blob 哈希核对的原始 Buffer；由调用者拥有。
try { /* 由宿主在另行授权后消费；本端口不会执行内容。 */ }
finally { result.bytes.fill(0); }
```

构造只验证参数及复制限额，无文件/Git I/O。每次方法调用建立独立操作和截止时间；返回元数据深冻结，字节归调用方且可变，不能永久证明其未被改写或擦除外部副本。调用方可重复读取，不宣称持久的一次性交付。

## 状态、基线与限制

`report_version: "1.0.0"`，`scope: "local_git_committed_snapshot"`，`authorization: false`。成功为 `inspected`，失败为 `rejected`、`snapshot: null` 及固定 fault。返回 commit/tree、对象格式 sha1/sha256、branch/detached、条目相对路径/模式/对象 ID/长度；不输出提交消息、作者、远端 URL、绝对目录、Git stderr 或 Abort 原因。元数据本身可能包含敏感文件名，应由调用者按组织策略处理。

`index_state` 仅为当前抽样的暂存区与 HEAD 比较，值为 matches_head、differs_from_head 或裸仓库的 not_applicable。**它不是“工作区干净”判断**。未暂存、未跟踪和子模块工作树一律 not_inspected，不读取它们的正文；不调用可能触发 clean 过滤器的 worktree status。暂存的 gitlink 差异仍参与 index 比较。

操作末尾重新核对 HEAD、分支引用、Git 目录路径和根目录/Git目录设备与 inode。可观察的变化拒绝，已读字节清除。重复检查不是原子磁盘快照；不能检测全部瞬时变动、阻止返回后的并发写入或授予写租约。index 状态亦不是不可变事实。需要这些保证时必须由后续工作区租约、隔离与服务端绑定实现。

默认上限：30 秒总操作期限、10000 条清单、每个普通 Git 输出 2 MiB、每份读取 blob 4 MiB；构造 options 可分别降低 `timeoutMs/maxEntries/maxOutputBytes/maxBlobBytes`，不可提高。短文本输出另限 8 KiB，stderr 只计费并清除（64 KiB 上限），目录/相对路径限 4096 UTF-8 字节。超限整次拒绝，无分页截断冒充完整清单；大 blob 可在目录中列出，但读取时拒绝。预算不等于 Git 进程总内存、解压资源、文件系统缓存或总磁盘 I/O。

只继承固定 Linux 环境；禁用全局/系统 Git 配置、替换对象、可选锁、懒加载、交互提示和所有网络协议。固定 Git 参数关闭 fsmonitor/hooks/外部属性来源等；仅执行 rev-parse、symbolic-ref、ls-tree、index-only diff-index 和原始 cat-file，不使用 shell、textconv、过滤器或仓库脚本。仓库本地配置/对象仍由可信 Git 解析；这不是恶意同用户文件系统、恶意 Git 二进制或跨租户不可信仓库沙箱，不绕过 Git 自有仓库所有权保护。

截止与取消会向当前独立 Git 进程组发 SIGKILL，并等待其 close 后才返回，不把本地清理当作停止别处的 Agent。JS 定时器、原生文件系统调用和不可中断内核等待不是强制资源边界；调用方仍须外层进程级超时及沙箱。CLI 的 SIGINT/SIGTERM 也走此清理流程。

退出码：0=inspected；2=操作拒绝/环境不可读；3=报告输出不可用；64=命令参数错误；124=超时；130=SIGINT/取消；143=SIGTERM。help 也是 0，但为 `status: "help"`、`executed: false`，不是仓库验收。自动化同时检查状态与退出码。

## 验收与后续

`node --test tests/local-repository.test.mjs` 使用实际临时 Git 仓库和子进程，故障用例明确注入暂停、替换和错误输出。完整 CI 和精确提交证据见 PR #65。[执行记录](../tasks/ZT18-01-A-execution.md)及[报告](../testing/zt18-01-a-report.md)保留范围。

A不实现完整RepositoryPort的远端连接/项目关系/组织授权，也不将本机文件权限替代服务端权限。原 ZT03-02-B、Issue #32/#35 与 Draft PR #33 仍阻断持久联调。

官方语义参考：[Git 全局参数与环境](https://git-scm.com/docs/git)、[ls-tree NUL/完整树输出](https://git-scm.com/docs/git-ls-tree)、[cat-file 原始对象](https://git-scm.com/docs/git-cat-file)、[status 的工作树与index区别](https://git-scm.com/docs/git-status)。实际兼容证据以本仓库测试版本为准，不依据文档声称所有版本都支持。
