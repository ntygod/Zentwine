# 测试与证据

## 适用范围

继承 [根约定](../AGENTS.md)。用新增用例表达新行为，不删除、跳过、聚焦或弱化受保护历史断言。

## 放置与执行

纯规则/API：根 test.mjs 套件；浏览器：browser；真实临时数据库：integration；开发生命周期：development；质量/harness 的 Python 正反例：quality。具体命令以 [验证路由](../docs/harness/verification.md) 和 [package scripts](../package.json) 为准。

Fake、故障注入、真实 loopback、实际 PG 与真实供应商要分别标记。缺凭据/依赖不是成功；计划定义了用例不等于已经执行。不要为了 CI 绿把严格模式改为允许遗漏。

同步使用条件和截止时间，不用任意长 sleep。每次测试隔离租户/目录/端口；总是清理自己创建的进程和资源，不终止其他用户服务。

## 交付

记录精确提交/tree、工具版本、实际数量、失败/取消/跳过和制品归属；旧 head 的绿灯不覆盖新提交。测试自审不冒称第三方独立认证。报告索引见 [验收证据](../docs/testing/README.md)。
