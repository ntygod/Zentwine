# ZT02-01 执行记录

输入：main@921980b45926c46cc1d6fc8c0c1d5446b672fcfa，源码树1b06b3c5f48cbfb557732b3e52f9f4344b28100d。沿用已有分支`feat/ZT02-01-identity-sessions`和[Issue #14](https://github.com/ntygod/Zentwine/issues/14)；误建的#15已标记重复，不作为完成计数。

状态：Done（限定实现验收）。实施与自审为本次AI开发会话，不冒称第三方审核。最终精确提交复验及合并以[PR #16](https://github.com/ntygod/Zentwine/pull/16)为准；后续修改不会自动继承前次测试结果。

## 范围

五张真实身份表与首个业务迁移；非特权PostgreSQL仓储；受信任本机票据签发；一次性消费、可撤销会话、轮换、组织切换版本与逐请求租户上下文；安全Cookie/CSRF/Origin/限速和日志边界。默认不开启身份，不改变旧bootstrap或界面契约。

## 已取得证据

修复提交aa6333f272213f475db3c4d8b2af1384979f6a55通过[统一CI 36088939160](https://github.com/ntygod/Zentwine/actions/runs/36088939160)，实际PR候选被测提交61a03c8b361876c40dd51fab74695fd453e8fb34，树23ac69de098f3fa3d1022866e71de7a7ace0d21d。145主工程测试（原125+新20）及28真实身份数据库场景通过；原浏览器、数据库、迁移和耐久回归保留。首个真实业务迁移fresh/upgrade/retry/rollback验证通过。

收尾提交将事务隔离级别明确写为READ COMMITTED并补齐本报告；最新提交必须重新通过完整CI。最终制品、摘要及该提交结果保存在PR，不将本段前次成功当作最终结果。

## 文档与回退

[使用说明](../development/identity-sessions.md)、[ADR-011](../adr/ADR-011-identity-sessions.md)、[验证报告](../testing/zt02-01-report.md)。关闭local-ticket模式恢复只读壳；保留身份库，不自动执行有损down脚本。本轮不完成生产SSO、资源策略、Agent授权或登录UI。下一工作包ZT02-02。
