# ZT02-01 执行记录

输入：main@921980b45926c46cc1d6fc8c0c1d5446b672fcfa，源码树1b06b3c5f48cbfb557732b3e52f9f4344b28100d。沿用已有分支`feat/ZT02-01-identity-sessions`和[Issue #14](https://github.com/ntygod/Zentwine/issues/14)；误建的#15已标记重复，不作为完成计数。

状态：InProgress。实施与自审为本次AI开发会话；按既有授权推进，不冒称第三方审核。

## 范围

五张真实身份表与首个业务迁移；非特权PostgreSQL仓储；受信任本机票据签发；一次性消费、可撤销会话、轮换、组织切换版本与逐请求租户上下文；安全Cookie/CSRF/Origin/限速和日志边界。默认不开启身份，不改变旧bootstrap或界面契约。

## 验证

核心和接口负例、真实PostgreSQL并发/重启/撤权集成、迁移生命周期及原有回归均为本轮验收要求。具体结果、精确提交、失败修复和制品见后续PR及[验证报告](../testing/zt02-01-report.md)，当前不预填通过。

## 文档与回退

[使用说明](../development/identity-sessions.md)、[ADR-011](../adr/ADR-011-identity-sessions.md)。关闭local-ticket模式恢复只读壳；保留身份库，不自动执行有损down脚本。本轮不完成生产SSO、资源策略、Agent授权或登录UI。下一工作包ZT02-02。
