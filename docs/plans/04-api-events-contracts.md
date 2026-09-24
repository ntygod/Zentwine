# 04｜共享 API、事件与运行时契约

本文是 Zentwine 自有接口提案，不是供应商 SDK 的方法清单。任务开始前以 `packages/contracts` 中经评审 schema 为准；变更时同时更新消费者测试。

## 1. HTTP 与命令规范

业务前缀 `/api/v1/orgs/{orgId}`。读取使用 GET，不产生执行、发布等副作用；列表使用 cursor 和 limit，稳定排序。写入携带身份、`Idempotency-Key` 与预期版本；响应返回 operation_id、object_version、trace_id。

`POST /workspaces/{id}/runs` 明确启动；`GET /workspaces/{id}` 仅打开。`POST /runs/{id}/stop` 返回 202 与 stop_requested，不伪称已停止。长操作通过 GET operation 和事件获得结果。

统一错误 `{code,message,details,trace_id,retryable}`；常用 400 invalid_input、401 unauthenticated、403 forbidden、404 unavailable_resource、409 version_conflict、412 stale_baseline、422 invalid_transition、429 rate_limited、503 unavailable。跨租户资源不得通过错误内容泄漏存在性。输入含额外权限字段默认拒绝或忽略并记录，不回显密钥。

## 2. 事件信封

```json
{
  "event_id":"evt_demo_001","schema_version":"1.0",
  "org_id":"org_demo","aggregate_type":"run","aggregate_id":"run_demo",
  "aggregate_version":8,"event_type":"run.waiting_input",
  "occurred_at":"2026-09-24T08:00:00Z","recorded_at":"2026-09-24T08:00:01Z",
  "actor":{"kind":"agent","id":"agent_backend","on_behalf_of":"member_demo"},
  "correlation_id":"flow_demo","causation_id":"cmd_demo","trace_id":"trace_demo",
  "payload":{"approval_request_id":"approval_demo"}
}
```

每聚合序号用于拒绝过时状态；重放以 event_id 去重。不同聚合不承诺全局排序。事件负载存摘要和对象引用，不传播完整客户材料。字段扩展向后兼容；破坏性变更提升 major，并有迁移和兼容测试。

实时通道按身份订阅受授权对象，断线使用 cursor 恢复；历史超出窗口则返回 reset_required，由客户端重新读取快照。终端输出等高频流单独限流，不淹没业务事件。

## 3. RuntimeAdapter 的平台接口

```ts
interface RuntimeAdapter {
  describe(): Promise<CapabilityReport>;
  start(input: StartRun): Promise<RunHandle>;
  subscribe(handle: RunHandle, cursor?: string): AsyncIterable<RuntimeEvent>;
  respond(handle: RunHandle, request: InputResponse): Promise<Acknowledgement>;
  stop(handle: RunHandle, reason: string): Promise<StopReceipt>;
  inspect(handle: RunHandle): Promise<ObservedRunState>;
  collect(handle: RunHandle): Promise<ArtifactManifest>;
}
```

这是预期端口；resume、steer、fork、checkpoint、usage 等通过能力报告声明 native/emulated/unsupported/experimental。仿真实现需说明损失，例如通过新 Run 接替不是原生会话恢复。关键控制 unsupported 时拒绝该工作，不静默提权。

StartRun 固定 task、context_snapshot、workspace、model_binding、policy_snapshot、budget_reservation、lease_epoch、input_artifacts。令牌在 Runner 受控获取，不放该对象明文。RuntimeEvent 区分工具请求、审批、状态、可展示摘要、产物和用量；不索取或保存模型私有思维链。

## 4. 跨模型通信与产物

Message 保存 message_id、flow/node、sender、recipient、kind、subject_revision、artifact_refs、requires_action、expires_at。kind 为 question、answer、finding、artifact_published、change_proposal、review_request、blocked。

发送权限、阅读权限、采用权限分别检查。接收别人的文本不继承权限；自然语言“批准了”不是 Approval。Artifact 保存生产 run、内容 hash、版本、media_type、source_commit、权限、验证状态。消费时建立 ArtifactConsumption，记录哪个 Run 使用了哪版产物。

## 5. 审批与控制权

ApprovalRequest 绑定 subject_hash、动作、资源、风险、可选项和有效期。审批响应必须重新鉴权并校验当前状态；拒绝默认不执行，不自动换工具绕过。过期响应返回明确 stale。

WorkspaceLease 包含 holder、epoch、expires_at、observed_stop。handoff 先冻结旧写入并检查进程，再保存快照、递增 epoch、给新控制者权限。不允许仅前端点击“接手”就双写。

## 6. 证据与发布

Evidence 记录 verifier_identity、spec/contract、commit_set、environment_digest、protected_test_plan_hash、command/result、artifact_hash、created_at、stale_reason。模型报告单独标识 `agent_claim`，不能伪装 `trusted_verification`。

ReleaseManifest 固定代码/配置/迁移/开关/验证清单。Deployment 与 Exposure 是不同资源。发布前 policy check 与可撤销短期执行授权配合，执行结果由外部系统回读。

## 7. 幂等、未知与兼容

幂等作用域为 org＋actor＋command_type＋key，保存请求摘要；同 key 不同 payload 返回冲突。外部提供幂等则透传，否则保留远端 operation marker 并 reconcile；无法确认时 unknown 等待人工或受控探测。

契约测试必须覆盖重复、乱序、断线、撤权、过时版本、审批重放和未知结果。JSON 示例用于语义，不包含真实供应商凭据或可直接连接的资源。
