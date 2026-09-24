# ZT01-04 执行记录

任务：[工程底座](../modules/01-foundation.md)。Issue：[8](https://github.com/ntygod/Zentwine/issues/8)。输入main@966a6e823713546c23ba684dda0ebd9e017a8996，源码树c097b38c12463c3f82e48a119f17b66811517aff；工作分支feat/ZT01-04-isolated-testkit。

状态：InProgress，待完整CI验证。实施和自审：已获负责人授权的AI实施者。

交付：确定性FakeRuntime、双租户不可变Fixture、可注入SQL端口及随机临时PG数据库/角色、事务RLS测试、临时目录、独立进程和浏览器上下文隔离、专用测试服务配置、文档及ADR-008。

本地Node22编译与27个Fixture测试已通过，属于开发辅助验证，不替代Node24正式工程CI。67个已有核心/API断言和7个浏览器场景保留。真实PG、并行浏览器、冻结锁及完整回归结果见后续本文件与PR Checks。

新增根开发依赖pg8.16.3及其图，沿用已验证Spike锁中的版本/摘要，不导入Spike实现。现有依赖版本保持不变。为受限开发环境构造锁blob的临时工作流仅处理固定SHA的已核对文本，不checkout/执行仓库代码、不更新ref；最终树不保留该工作流，常规CI保持只读。

完整产品E01–E52、ZT02生产身份、ZT12协议、ZT15环境与真实多模型均未因此完成。没有生产部署、付费模型或客户数据。进程SIGKILL后的最终清理由专用测试容器生命周期承担，不宣称finally无条件执行。

下一工作包ZT01-05。具体使用方式见[测试指南](../development/testkit.md)，决定见[ADR-008](../adr/ADR-008-isolated-testkit.md)。
