# ZT01-04 执行记录

任务：[工程底座](../modules/01-foundation.md)。[Issue #8](https://github.com/ntygod/Zentwine/issues/8)，[PR #9](https://github.com/ntygod/Zentwine/pull/9)。输入main@966a6e823713546c23ba684dda0ebd9e017a8996，源码树c097b38c12463c3f82e48a119f17b66811517aff；工作分支feat/ZT01-04-isolated-testkit。

状态：Done（限定实现验收；合并须重新核对最终head与base，实际状态见PR）。实施和自审由负责人已授权的AI实施者承担，不声称独立第三方审核。

## 实现

确定性FakeRuntime、双租户不可变Fixture、可注入SQL端口及随机临时PG数据库/非特权角色、事务RLS验证、临时目录、隔离测试启动器、浏览器上下文和并行Worker、专用Compose环境及只读CI。

保留原67个核心/API及7个浏览器场景；新增27个Fixture测试与2个浏览器隔离场景。真实PG共13个场景，并在Compose启动的第二个服务中重复验证同13个场景，不计为26个独立场景。Fake自述不能作为真实模型证据。

## 已核验的精确证据

功能head：02122050e3e710f00d4b822ee5fed6f043ddfdc0。
实际PR合并测试提交：956df63c3ec42dedec78ad21a4812b32cafca260。
源码树：099d3c36fde22b9a844aec28c9cfcc3ae0c2503a。

[工程CI](https://github.com/ntygod/Zentwine/actions/runs/35987425320)包含冻结安装、格式/依赖边界、构建/类型、94个核心/API/Fixture、9个真实浏览器、端口清理和源码不变。Node24.21.0、pnpm11.10.0；当次依赖审计无已报告漏洞。
[测试基础CI](https://github.com/ntygod/Zentwine/actions/runs/35987425271)包含27 Fixture、13真实PG、Compose重跑13场景，以及缺配置退出1。
[既有故障回归](https://github.com/ntygod/Zentwine/actions/runs/35987425353)和[文档CI](https://github.com/ntygod/Zentwine/actions/runs/35987425363)通过。

下载两套artifact，核对SHA256、实际测试提交、源码逐文件和冻结锁一致。详细摘要见[验证报告](../testing/zt01-04-report.md)。当前文档提交及以后变更仍须通过PR最新Checks，不能将历史结果自动转移到不同代码。

## 决策、失败和范围

pg8.16.3仅根开发依赖，沿用Spike锁的版本/摘要，不导入Spike实现。原依赖版本不升级。临时锁blob作业只处理固定SHA文本、不checkout/执行仓库代码、不更新ref，最终树不保留；常规CI只读。

首轮新数据库工作流因动态job端口表达式位于job.env而未启动；修正到step作用域后真正执行成功。没有删除断言、跳过数据库或放宽安装门禁。主体代码首轮工程回归即通过。

无生产部署、客户数据或付费模型。测试权限/RLS setting不等于生产身份；临时目录/网络拦截不等于执行沙箱；进程SIGKILL或CREATE应答丢失时，专用容器生命周期承担最终清理。完整E01–E52、ZT02/12/15与live异构能力不因此完成。

使用方式见[测试指南](../development/testkit.md)，决定见[ADR-008](../adr/ADR-008-isolated-testkit.md)。下一工作包ZT01-05。
