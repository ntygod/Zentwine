# 应用层

## 适用范围

适用于 apps 子树，继承 [根约定](../AGENTS.md)。Workbench 管组织与协作入口，Studio 是可独立打开的 coding 工作台入口；desktop 仍是占位，不把 README 当成可运行实现。

## 修改前

按任务读 [工作台导航](../docs/development/workbench-navigation.md) 或 [对象页](../docs/development/resource-object-page.md)。共享交互进入 [UI 包约定](../packages/ui/AGENTS.md)，不要复制一套状态/权限判定。

应用只依赖 ui、contracts、React；不直接依赖 client、db 或供应商 SDK。以 [边界检查](../scripts/check-boundaries.mjs) 为准，不为方便接 API 放开依赖。

## 行为与验证

组织切换清理旧上下文和订阅；拒绝/空态要真实。显示按钮不赋权限；服务端独立鉴权。深链、刷新、挂载不产生执行或批准副作用。

运行 `pnpm check`、`pnpm test:e2e`；授权/审批页面还运行专用组织 PG 浏览器测试，见 [验证路由](../docs/harness/verification.md)。样例和可用业务路径明确区分。
