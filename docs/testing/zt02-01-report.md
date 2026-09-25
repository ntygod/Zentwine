# ZT02-01 验证报告

状态：等待精确提交CI。基线921980b45926c46cc1d6fc8c0c1d5446b672fcfa。

新测试位于tests/identity-security.test.mjs和tests/identity/persistence.test.mjs。前者覆盖配置、随机凭据、Cookie、CSRF、限速、错误脱敏和未认证入口；后者运行生产仓储与真实PostgreSQL，覆盖一次性票据、事务回滚、重启、双组织同号、并发切换、撤权、过期、轮换与HTTP边界。

原有测试不得删除或降低断言。首个业务迁移应通过既有fresh/upgrade/retry/rollback测试；这只证明开发环境中的迁移，不批准在生产运行down SQL。

本地工具版本可能不同于正式Node24.21.0基线，本地编译结果不替代CI。使用合成身份，无客户数据、供应商调用或公网部署；旧浏览器场景不等于新登录UI验收。
