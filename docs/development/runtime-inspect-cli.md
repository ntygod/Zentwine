# 终端交接包检查

ZT12-01-A8 / Issue #61。此命令与 Studio 本地检查台复用 `createRuntimeInputInspection` 和 `RuntimeInputBundle`，不是执行宿主、授权服务或独立可信验证器。通过后只给出元数据结果，不领取或执行原始字节。

## 使用

先按仓库说明安装冻结依赖并 `pnpm build`。支持的验收环境是 Linux 与仓库固定的 Node 工具链；没有 `O_NOFOLLOW` / `O_NONBLOCK` 的平台明确失败，不宣称 Windows 支持。

```sh
node scripts/runtime-inspection-example.mjs /tmp/zentwine-inspection-example
node scripts/runtime-inspect.mjs /tmp/zentwine-inspection-example
node scripts/runtime-inspect.mjs /tmp/zentwine-inspection-example --timeout-ms 60000
```

目录必须由用户显式指定。读取 `plan.json`；按计划 `producers` 顺序读取 `producer-1.ndjson` 等；按 `consumer.input_artifacts` 顺序读取 `input-1.bin` 等。与 A7 示例完全兼容。顺序是明确文件约定，不按 ID、文件名内容或目录扫描猜测；计划不接受文件路径。多余文件忽略。源文件必须是单链接普通文件，拒绝符号链接、硬链接、目录、设备与 FIFO。选中根目录本身不能是符号链接；祖先路径按用户给出的路径解析一次。

所有必需文件先做类型和大小预检并只读打开。全部报告通过后才开始任何产物正文读取。复用原 EOF、严格事件、完整产物集合、长度和 SHA-256 检查；任一失败整批拒绝。内容通过后也只产生结果并关闭读取器，不调用 `takeAll`。

## JSON 与退出码

标准输出只有一行 JSON，不输出路径、原始异常、正文或供应商消息；调用方可显式用 shell 重定向保存结果（注意重定向本身会覆盖目标文件）。`plan_sha256` 是本次读取的原始计划字节摘要，包含其空白，不是来源签名；`checked` 是已检查数量，不代表失败时可以使用部分产物。即使退出 0，也必须检查 `status`：`--help` 为 `help` 且 `executed:false`，不是成功检查。

| 退出码 | 含义 |
|---|---|
| 0 | `passed`：本地报告与全部字节一致；或显式 `--help` |
| 2 | `rejected`：报告/产物/读取中变化不符合检查条件 |
| 3 | `unavailable`：缺构建产物、平台不支持、资源清理或输出失败 |
| 64 | `invalid_input`：参数、计划、必需文件或预检大小/类型错误；未开始整批检查 |
| 124 | `timed_out`：本地截止时间到达 |
| 130 / 143 | `cancelled`：取消 / SIGINT，或 SIGTERM |

固定 `report_version:1.0.0`、`authorization:false`、`verification:unverified`、`producer_trust:reported_not_authenticated`。JSON 输出失败时不能保证交付 JSON，进程仍非零退出。结果只表示这次本地检查，不能直接用作生产批准或执行令牌。

默认检查截止时间 30000ms，可指定 1–300000ms 的十进制整数。截止时间与 Abort 覆盖读取、阶段间等待和最终资源清理；移除信号监听、清除计时器、关闭全部已获取文件描述符后返回。检查与清理期间取消不能返回成功。原生内核 I/O、故障文件系统或阻塞事件循环无法被 JavaScript 计时器强制终止，外层 CI 仍需进程级超时；重复或强制信号也可能直接终止而没有 JSON。

## 文件与信任边界

同一个只读描述符用于预检和读取，使用不跟随末级链接、非阻塞打开和再次 fstat/lstat。检查 inode、设备、长度、mtime/ctime、模式和链接数；每文件 EOF 与整批结束再次检查，路径替换或可观察变更拒绝。单块最大 64KiB，文件预算与 A7 一致；不读取清单中任意路径，不加载包中的脚本或模块，不联网、不修改输入内容（文件系统可能更新读取时间）。

这不是面对恶意同用户并发写入、挂载替换、恶意文件系统或系统管理员的文件沙箱；stat 检查不是文件系统快照，不能保证发现所有瞬时修改。应使用用户控制的本地静态副本。检查后的源文件仍可改变；报告无签名，也不是权限或代码安全证明。程序释放仍拥有的缓冲，不保证擦除 OS/平台/调用方副本。

脚本可以从团队自己的自动化流程显式调用，但不修改或取代本仓库现有质量门禁。没有真实模型、生产存储、版本 CAS 或团队执行功能；#32/#35/PR #33 及父 #46 的前置仍保留。
