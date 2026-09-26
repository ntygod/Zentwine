# ZT03｜领域版本、事件与审计基础

状态：ZT03-01限定代码验收通过，最终合并以PR #31为准；其余工作包Planned。负责人职责：后端、数据、质量。依赖模块：ZT01、ZT02。对应蓝图：12、17、19。

## 目标

给所有应用和执行提供一致的对象、版本、命令、事件和状态规则。此模块交付通用原语；Spec、Project 等业务规则由其领域模块拥有，避免万能 JSON 表承载所有逻辑。

## 数据约定

实体、revision、relation、outbox、inbox、operation、audit_event、tombstone；重要版本有 content_hash、canonicalization_version、actor 和权限。索引以 org_id＋对象/状态/更新时间为基本组合。使用事务及 expected_version 乐观锁。

只允许 approved revision 内容新增新版本，不允许原地改写；删除按独立保留策略处理。事件 schema 见公共契约。

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT03-01 | ZT02-01 | 实现迁移机制、租户 repository、RLS 和运行/迁移数据库身份分离 | 应用身份不能 bypass RLS；批量查询和关联表同样隔离 |
| ZT03-02 | ZT03-01 | 实现版本、摘要、关系和 compare-and-swap 命令基础库 | 两人基于同版提交仅允许合法转换；冲突有新旧版本且不静默覆盖 |
| ZT03-03 | ZT03-02 | 实现事务 outbox、消费者 inbox、序号、重放与死信 | 事务回滚不发事件；重复/乱序不倒退状态；重建投影不触发外部动作 |
| ZT03-04 | ZT03-03 | 实现 Operation 状态、幂等作用域、payload 摘要和远端对账端口 | 同 key 不同请求冲突；超时无法确定时保留 unknown，不盲目重试 |
| ZT03-05 | ZT03-02、ZT03-03 | 实现审计查询、对象历史、删除 tombstone 和保留挂钩 | 可追溯批准人和版本；敏感内容可按政策清除，历史不泄漏旧权限 |
| ZT03-06 | ZT03-04、ZT03-05 | 完成状态模型属性测试、灾难重放 Fixture、查询索引基准 | 任意非法转换拒绝；百万级事件分页与重建有报告；相同输入重放得到一致投影 |

## API 与事件

拟建 `/objects/{type}/{id}/history`、`/operations/{id}`、`/events?cursor=`。事件分页按授权集合筛选；不存在/不允许对象不泄漏具体名称。

## 升级与风险

schema 扩展先兼容消费者，破坏性变更提升 major 并迁移。outbox 积压、deadletter、幂等冲突和 unknown operation 有独立告警。回滚代码不能回滚已发送外部事实；通过对账和补偿处理。
