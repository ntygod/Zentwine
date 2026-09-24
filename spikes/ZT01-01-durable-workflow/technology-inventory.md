# ZT01-01 技术与许可核对清单

日期：2026-09-24。仅本实验；不表示主产品选型已批准。记录官方声明，分发时仍需检查实际依赖许可证和 notices，不是商用合规结论。

| 组件 | 选择版本 | 许可资料与范围 |
|---|---|---|
| Node.js | 24.21.0（CI） | [Node LICENSE](https://github.com/nodejs/node/blob/v24.21.0/LICENSE)，包含 Node 与捆绑组件声明 |
| Temporal TS SDK | 1.24.0 | [SDK LICENSE](https://github.com/temporalio/sdk-typescript/blob/v1.24.0/LICENSE)，MIT；测试实际使用 client/common/testing/worker/workflow |
| Temporal CLI | 1.9.1 | [CLI LICENSE](https://github.com/temporalio/cli/blob/v1.9.1/LICENSE)，MIT；归档包含其服务依赖 |
| PostgreSQL | 17.11 | [PostgreSQL License](https://www.postgresql.org/about/licence/)；CI 保存镜像实际 RepoDigest |
| node-postgres | 8.16.3 | [pg LICENSE](https://github.com/brianc/node-postgres/blob/master/LICENSE)，MIT；锁定具体包 |
| TypeScript | 5.9.3 | [TypeScript LICENSE](https://github.com/microsoft/TypeScript/blob/v5.9.3/LICENSE.txt)，Apache-2.0 |
| 类型声明 | @types/node 22.15.30；@types/pg 8.15.4 | 按安装包 LICENSE 与锁定依赖清单核对；不作为生产运行时 |
| npm | Node 分发附带版本 | CI 记录精确 npm 版本；仅隔离 Spike 安装，不取代规划中的 pnpm workspace |

Linux x64 Temporal CLI 归档 SHA-256：`09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5`，来自 [1.9.1 官方 Release](https://github.com/temporalio/cli/releases/tag/v1.9.1)。其他平台不复用该摘要。

依赖解析结果见 package-lock 与 CI 的 dependency-tree.json。没有声称所选每个辅助包都是最新版本；选择固定版本进行兼容验证，生产采用前仍需漏洞扫描及复核。npm 安装报告的安全问题必须记录并评估，不能通过忽略退出码声称安全。

React、Fastify、Monaco、pnpm、桌面宿主、对象存储及生产镜像未在此实验执行；在相应任务选定并锁定，不编造兼容验证。Claude/Codex 的账号授权、商业使用和数据处理政策仍待 ZT13/14 逐项验证。
