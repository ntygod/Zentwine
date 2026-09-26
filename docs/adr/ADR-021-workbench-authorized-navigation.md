# ADR-021｜基于服务器会话的组织路由

状态：Accepted（限定实现）。代码快照经CI36238790989完整验收，最终文档提交复验和合并见PR #39。关联ZT04-02、Issue #38。前置ZT04-01及ZT02-01已满足，ZT03-02-B的兼容阻断不改变。

## 决定

当前仅实现组织概览、可访问目录与负责人治理概览。采用严格路径识别和原生文档导航，无新增路由依赖；主机的SPA回退仅负责交付外壳。URL、组织列表、导航可见性都不是授权，沿用每个真实API的会话/context_version/成员和资源校验。

client包提供可独立测试的请求代次控制器，ui包以React useSyncExternalStore订阅不可变快照，workbench只消费共享契约与UI。切换前先清空再发请求，旧响应经取消和代次双重抑制；错误与页面隐藏也不保留受保护组件。明确POST才能选组织；深链刷新、后退、focus和恢复网络只读。

选择完整文档导航而非在本轮引入SPA路由/缓存框架，以减少旧组织状态跨路由存活。代价是主题和查询输入不跨页保留，治理动作仍在现有控制台，页面可能多一次会话读取。这不是ZT04-04实时同步，持续可见的静态快照不承诺即时撤回。

## 备选和拒绝

拒绝把org_id写入浏览器存储作为全局权限；拒绝用URL自动选组织；拒绝仅隐藏菜单而不验证直接API；拒绝将未实现的项目和执行页面映射为成功的空业务页。延续共享渲染错误边界，不把错误原文或token放入URL或UI。

## 参考与验收

React官方useSyncExternalStore要求稳定订阅、状态不变时返回同一快照及不可变快照，本控制器按该接口实现。参考：https://react.dev/reference/react/useSyncExternalStore （2026-09-26核对）。

MDN的pageshow包含从前进/后退缓存恢复，pagehide不能保证每种终止路径都触发，因此同时检查visibilitychange和恢复读取，不将事件作为安全权威。参考：https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event 与 https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event （2026-09-26核对）。

验收必须含真实PG/Chromium正例与访客隔离、直接API拒绝、深链刷新/后退、提交前清空、晚响应竞态、双窗口变化、撤权和故障清空，最终精确head全量CI与制品通过才合并。回退不涉及数据库。
