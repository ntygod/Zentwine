# 03｜领域对象、状态与一致性

## 1. 统一字段与身份

业务实体使用稳定 opaque ID；显示编号如 REQ-21 是组织内人类可读标识，不用于绕过租户边界。基本字段：`id, org_id, object_version, created_at, updated_at, created_by, deleted_at`。时间存 UTC，展示使用用户时区；不以客户端时钟排序授权或控制租约。

主体分 Human、Agent、Service，Agent 必须绑定 `accountable_owner_id` 与 `delegation_id`。参与者不是授权人；请求上下文中的 org_id 由身份映射验证，不能信任客户端提交。

## 2. 聚合和数据所有权

| 聚合 | 核心对象/字段 | 权威模块 |
|---|---|---|
| 组织身份 | Organization、Team、Membership、RoleBinding、Session | ZT02 |
| 目标与机会 | Signal(source,consent)、Opportunity、Mission(scope,success,owner)、Experiment | ZT05 |
| 交付意图 | DeliveryUnit、SpecRevision(parent,content_hash,status)、AcceptanceCriterion(stable_key) | ZT06 |
| 变更与决策 | Decision(subject_hash,scope)、ChangeRequest、ImpactEdge、AdoptionReceipt | ZT07 |
| 设计与架构 | DesignRevision、ContractRevision、ADR、ServiceNode、DependencyEdge | ZT08/09 |
| 计划 | Project、WorkPackage、PlanRevision、Dependency、CapacityReservation、Scenario | ZT10 |
| 上下文 | Source、KnowledgeClaim(epistemic_state)、ContextSnapshot、PermissionProjection | ZT11 |
| 能力 | ModelProfile(provider,model_id)、RuntimeProfile、AgentProfile、CapabilityReport | ZT12 |
| 执行 | FlowRevision、FlowRun、NodeRun、Run、Attempt、NativeSession、Message、Artifact | ZT16/12 |
| 工作区 | Workspace、WorkspaceLease(epoch,holder,expires_at)、Checkpoint、Environment | ZT15 |
| 代码 | RepositoryBinding、ChangeSet、PullRequestMirror、IntegrationCandidate | ZT18 |
| 验证 | VerificationPlan、VerificationRun、Evidence(commit_set,verifier,result) | ZT19 |
| 运行 | ReleaseManifest、Deployment、Exposure、Incident、Observation | ZT20 |
| 治理 | Delegation、PolicySnapshot、Approval、BudgetReservation、UsageLedger、RetentionRule | ZT02/26 |
| 学习 | Outcome、LearningProposal、EvaluationRun、SkillRelease | ZT28/21/23 |

关系多对多，必须带 `relation_type, source, subject_revision, object_revision, org_scope`。不强制一仓库对应一项目，也不把交付单元等同 PR。

## 3. Run 与 Attempt 的精确定义

WorkPackage 是业务工作。Run 是一次固定目标和上下文的执行请求。Attempt 是该 Run 的传输/进程级尝试；只有输入、权限和模型绑定仍兼容时可以建立新 Attempt。

需求或模型实质改变，创建新 Run 并保存 `supersedes_run_id`；不能覆盖原请求。Session 是供应商原生会话，可以续用或分叉，但不能改变旧 Run 的审计事实。FlowRun 编排多个 NodeRun，NodeRun 引用一个或多个经过显式选择的 Run。

## 4. 状态机

| 对象 | 主路径 | 关键守卫 |
|---|---|---|
| SpecRevision | draft → in_review → approved → superseded / retired | 批准绑定内容摘要；approved 内容不可 UPDATE |
| WorkPackage | draft → ready → in_progress → in_review → integrating → done | Ready 要有责任和输入；Done 要有适用验收证据 |
| Run | queued → preparing → running ↔ waiting_input → succeeded / failed | succeeded 仅指本次执行条件满足，不直接完成需求 |
| 停止 | 任意非终态 → stop_requested → cancelled / failed | 需要 Runner 和子进程确认；超时进入 unknown，不假装停止 |
| DeliveryUnit | candidate → exploring → awaiting_approval → implementing → accepting → accepted → released → observing → closed | 发布和启用分开记录；失败退回相应阶段不抹历史 |
| ChangeRequest | proposed → analyzing → awaiting_approval → approved → propagating → verified → closed | verified 取决于必需影响项完成重核 |
| Deployment | planned → deploying → deployed / failed / unknown | 远端确认；部署不等于启用 |
| Exposure | disabled → canary → expanding → enabled / paused / reverted | 观察规则和策略授权 |

`blocked, stale, sync_degraded, at_risk` 是独立标志，不覆盖主状态。等待人工与等待依赖分别记录。取消不撤销已发生外部动作；需要补偿计划。

## 5. 版本和批准

`SpecRevision` 与 `PolicySnapshot` 固定内容及 canonicalization_version。Approval 保存目标类型/ID、revision/hash、动作范围、批准主体、策略版本、有效期。执行前重新检查撤权和最新限制；旧批准不能覆盖新提交。

草稿共同编辑可以 CRDT；批准时从一致快照产生不可变版本，不能对批准正文继续 CRDT 合并。新规格下继续使用旧产物必须记录显式兼容结论或重新验证。

## 6. 一致性策略

聚合内事务＋乐观锁；命令更新带 expected_version，不匹配返回冲突。领域事件与业务更改同事务写 outbox；消费使用 inbox 去重。事件至少一次，外部副作用建立 Operation 记录并远端核对，不宣称全局 exactly-once。

权限撤销优先于缓存结果。执行写入依赖 lease epoch；旧执行即使有旧凭据也要被文件/进程隔离和工具网关阻止。断网后本地守护程序按租约停止写入，不能仅依赖数据库数字。

## 7. 五种事实不混同

批准意图、观察实现、Agent 报告、运行版本和产品效果分别标识。来源、观察时间、有效范围和不确定性随记录保存。摘要属于派生信息，不赋予其源材料之外的权限。

删除策略协调版本留痕与隐私要求：内容可按政策清除或加密销毁，保留必要 tombstone 和最小审计，不能以“版本不可变”为由永久保留所有内容。
