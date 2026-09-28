# 客户端与本地运行检查

## 适用范围

继承 [共享包约定](../AGENTS.md)。client 只依赖 contracts，不导入 UI、db 或供应商模块。

按所改层读取 [事件观察](../../docs/development/runtime-observer.md)、[字节流](../../docs/development/runtime-stream.md)、[输入产物](../../docs/development/runtime-input-artifact.md)、[整批交接](../../docs/development/runtime-input-bundle.md)，不一次读完全部报告。

保留连续事件前缀、完整终态、精确引用/长度/hash、全输入覆盖与预算约束。所有报告通过后才能读整批产物，任一失败清理全部；不得先交付部分成功。

取消/超时应等待自身资源清理，不能把晚到结果写回新会话。构造器、读取与一次性 take 的副作用界线保持清楚；本地报告不授予执行权限、不证明供应商身份或数据库持久性。

运行 `pnpm check`；流/输入变更加真实 loopback、分块/截断、重复、取消和上限用例。UI/CLI 接入还需各自验收，不用纯逻辑测试代替用户路径。
