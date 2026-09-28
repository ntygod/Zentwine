# Studio

## 适用范围

继承 [应用约定](../AGENTS.md)，只补充独立 Studio。

当前本地交接检查台复用共享 UI/client；不是编辑器、执行宿主或团队 Run 持久化。读 [本地检查台](../../docs/development/runtime-inspector.md) 与 [终端同源入口](../../docs/development/runtime-inspect-cli.md)。

只有用户显式选择文件并点击检查才读取数据；页面打开、恢复路由不得开始 Run。通过校验仍不执行、上传、领取或预览产物内容。

取消、关闭、卸载、换组织和重置时隔离过期异步结果并释放仍拥有的缓冲；不承诺擦除平台/调用方副本。不要在页面重新实现摘要或整批状态机。

运行 `pnpm check`、`pnpm test:e2e`；涉及 inspection 的改动覆盖取消、失败、重复检查与结果隔离。扩大可执行能力前先处理 [当前阻断](../../docs/tasks/status.md)。
