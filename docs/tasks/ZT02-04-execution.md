# ZT02-04｜版本绑定审批执行记录

输入 main@570c9297369eb5ddf1e0caa9093ff76236ee47a4，Issue #21。状态 Done（限定实现验收）；代码已通过 [CI 36124062751](https://github.com/ntygod/Zentwine/actions/runs/36124062751)。最终文档提交复验与合并以 [PR #22](https://github.com/ntygod/Zentwine/pull/22) 为准。

## 交付

- 固化命令与content_hash，绑定主体、资源、环境及身份/成员/组织/资源/策略版本；独立人工批准与政策预授权分别记录来源。
- 短期一次性许可；只由原请求人领取和使用。审批和领证不启动执行，Agent不能借人类许可提权。
- 锁等待后及最后响应读取后重查时效和会话；消费、目录改名、回执和事件同事务，错误一起回滚。
- 当前身份过滤的持久游标通知；身份/组织/成员/策略治理事务内撤销。通知写入失败不得误报治理成功。
- 0004迁移、HTTP和服务器绑定工具、最小运行角色；默认开发入口不自动开启身份或审批。
- 242主工程与49审批集成/故障场景通过，共80新增独立场景；其余工程、浏览器、PG、WS、迁移与Temporal回归保留通过。

## 接续和修正

沿用已有Issue/PR及实现，不另建重复任务。修复Agent测试缺少resource.read的输入，同时保留approval_required断言；补充四项真实PG锁等待的提交前过期回归，覆盖决定、领证、撤销与通知。失败原因、被测树和范围见[验证记录](../testing/zt02-04-report.md)。旧测试断言、迁移、依赖锁和只读CI保持不变。

实现位于packages/policy/src/approvals.ts、packages/db/src/approvals.ts与services/api/src/approvals。理由见[ADR-014](../adr/ADR-014-bound-approvals.md)，使用见[指南](../development/bound-approvals.md)。

按既有授权实施和自审，不冒称第三方独立安全审核。仅人类scope资源目录改名；无真实模型、审批UI、生产部署或平台分支保护变更。下一工作包ZT02-05仍待开发。
