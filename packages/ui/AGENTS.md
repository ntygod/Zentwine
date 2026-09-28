# 共享 UI

## 适用范围

继承 [共享包约定](../AGENTS.md)。使用 React、client、contracts；不直接依赖 db 或供应商 SDK。

## 交互约束

先读 [设计系统](../../docs/development/design-system.md)。复用主题 token、原生语义、焦点/键盘与已有组件。共享业务组件在这里，应用层只组装；不要复制第二套请求状态机。

组织切换、卸载和取消时隔离旧请求结果；拒绝、未知、加载、空态分别表达。按钮禁用不是授权；任何批准/执行均须显式操作，页面恢复不自动提交。

本地 inspection 成功只显示元数据；不能因此提供执行或产物领取能力。有关边界见 [本地检查台](../../docs/development/runtime-inspector.md)。

## 验证

运行 `pnpm check`、`pnpm test:e2e`；覆盖键盘/焦点、主题、错误恢复、重复操作和组织上下文隔离。涉及真实组织业务时补相应 PG 浏览器测试，而非只测静态样例。
