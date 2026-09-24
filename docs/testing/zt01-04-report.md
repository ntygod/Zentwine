# ZT01-04｜隔离测试基础验证报告

日期：2026-09-24。数据全部合成；测试与自审由获授权的AI实施者完成。范围为测试基础，不是生产身份/真实模型/部署验收。

## 精确运行

功能head `02122050e3e710f00d4b822ee5fed6f043ddfdc0`；PR测试commit `956df63c3ec42dedec78ad21a4812b32cafca260`；tree `099d3c36fde22b9a844aec28c9cfcc3ae0c2503a`。GitHub PR测试使用合并候选而非head本身，两者明确区分。

| 检查 | 已有结果 |
|---|---|
| Node24.21.0 / pnpm11.10.0冻结安装、构建与类型 | 通过 |
| 核心/API/Fixture | 94/94通过，包含原67和新增27；0 skip |
| Chromium浏览器 | 9/9通过，两个Worker并行 |
| 真实PostgreSQL | 13/13通过 |
| Compose环境 | 启动健康后相同13场景通过，清理成功 |
| 原Temporal/PostgreSQL故障回归 | 通过；未修改旧断言 |
| 文档、边界、端口释放、源码不变 | 通过 |
| 当次依赖审计 | 无已报告漏洞；不是永久安全结论 |

运行：[工程](https://github.com/ntygod/Zentwine/actions/runs/35987425320)、[数据库及Compose](https://github.com/ntygod/Zentwine/actions/runs/35987425271)、[耐久故障回归](https://github.com/ntygod/Zentwine/actions/runs/35987425353)、[文档](https://github.com/ntygod/Zentwine/actions/runs/35987425363)。

PostgreSQL实际版本为17.11 (Debian 17.11-1.pgdg13+2)；镜像固定到sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232。服务端口由CI动态分配。四个临时数据库并行测试不共享行或角色；RLS在非超级用户、非表所有者上下文中验证。

## 重点失败路径

重复开始、模型/脚本冲突、旧context输入、拒绝不可覆盖、停止未确认、断线后结果已完成、重复/丢失/逆序事件、未知结果不当成功；未知或跨租户请求不执行。

数据库错误包含事务回滚、测试主体失败、表初始化失败、CREATE DATABASE失败后的角色清理、清理失败重试、忙时拒删、重复dispose以及使用已销毁handle。最后只检查当前suite分配的精确资源列表，避免并行suite互相干扰。fixture_only=false写入被CHECK拒绝。

环境护栏包括生产模式、远程/替代/带参数DSN、缺ACK、缺服务器标记、缺配置。浏览器上下文隔离存储和路由模拟，网络只允许本地三个服务。Fake网络测试拦截fetch/socket/http/process入口；它是回归护栏，不是针对恶意代码的OS隔离。

## 制品核验

- 数据库artifact：10802254912；SHA256 `775f8bc7a33bf5b91ab22224b35078bde22a654312361c711546f42b57bfb3f5`。
- 工程artifact：10802294942；SHA256 `5ab4b2c3239c55d5c0fd6010795e96f9da7104988464cd345987cde26ee22631`。
- 锁文件SHA256：`9efa8778cc3084badcc908e73852a37975446deb492bb1ce331c50d74a4e6995`。
- 下载后对照182个受追踪文件逐字节一致；工程/数据库artifact测试commit一致；日志计数与退出结果核对。额外本地文档与4组JSON Schema校验通过。

本报告自身和后续文档提交也要重新跑PR CI。最新head、最终测试commit、artifact及合并记录在[PR #9](https://github.com/ntygod/Zentwine/pull/9)与[Issue #8](https://github.com/ntygod/Zentwine/issues/8)更新，不使用循环自引用伪造“报告测过自己”的SHA。

## 失败修正与剩余边界

初始工作流动态端口引用位于不支持job上下文的位置，造成解析失败；移到运行步骤后修复并完整重跑。没有跳过数据库或将失败改成continue-on-error。

只验证Linux/真实PG17.11与合成业务表。生产迁移、真实多模型、完整租户身份、OS安全沙箱、长时间压力和进程SIGKILL后的JS清理未在本任务验证。强制终止或创建应答丢失时应销毁专用测试服务，不对未知资源自动扫删。回退本PR无需生产数据迁移。
