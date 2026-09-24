# ZT19｜独立验证、质量门禁与交付证据

状态：Planned。负责人职责：质量、平台、安全、业务验收人。依赖模块：ZT03、ZT06、ZT15、ZT18。对应蓝图：10。

## 目标

验证批准的需求是否被指定代码和环境满足，阻止模型以自述、修改必要测试或引用旧结果自证成功。支持单元、契约、集成、端到端、视觉、性能、安全、迁移、人工和用户验证。

## 对象和可信边界

VerificationPlan(spec_revision,criteria,protected_config_hash)、VerifierIdentity、VerificationRun(commit_set,environment_digest,dataset_hash,commands)、Evidence(kind,result,artifacts,scope,stale_reason)、Defect、AcceptanceDecision。

result 分 passed、failed、error、skipped、unknown；kind 分 agent_claim、trusted_tool_result、human_attestation。人工判断记录身份、版本和理由。Verifier 使用独立身份、受保护计划及隔离执行，不与实施者共享自批权限。

API `/verification-plans`、`/verification-runs`、`/evidence`、`/acceptance-decisions`；事件 verification.finished、evidence.stale、acceptance.decided。

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT19-01 | ZT06-01、ZT03-02 | 实现验收项→验证方法/责任/要求映射与版本化验证计划 | 不适合自动化的有人工责任；不能默认为全部自动通过 |
| ZT19-02 | ZT19-01、ZT15-02 | 建立独立 Verifier、隔离环境和保护的测试入口、测试数据版本 | 实施 Agent 无法改 verifier 配置或签发结果；构建脚本不接触生产 secret |
| ZT19-03 | ZT19-02 | 集成多类测试执行、报告解析、失败分类与最小复现 | 旧失败/新失败/环境失败/flaky/需求歧义区别；超时不当成通过 |
| ZT19-04 | ZT19-03 | 实现 Evidence 索引、摘要核验、权限及基线/配置变化导致失效 | 旧提交报告不可满足新候选；伪造报告和不匹配环境被拒绝 |
| ZT19-05 | ZT19-04、ZT18-05 | 实现组合候选验证、证据矩阵、人工验收和风险例外 | 必需项缺失阻断；例外有审批和到期；模型多数同意不能代替门禁 |
| ZT19-06 | ZT19-05 | 完成交付证据包导出、安全分享、故障/篡改回归与可信身份演练 | 从需求到具体报告可追溯；删测试、改 CI、重放旧签发、越权下载均测试 |

## 完成和运营

证据完整度与实际质量分别呈现。报告显示方法、版本、适用范围和未知，不给缺资料项目自动打满分。生产验收必须同时有可信运行和适用人工决定。测试基础设施故障可重跑，但不自动降低要求。
