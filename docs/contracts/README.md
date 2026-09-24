# Zentwine 协议草案与示例

这里的 schema 是共享语义的设计草案，不是已实现 API，也不是 Claude/Codex 官方 SDK 的参数。`*.example.json` 全为合成 Fixture，模型名称是占位标识，不可直接用于真实调用。

| 契约 | 内容 | 示例 |
|---|---|---|
| [runtime-start.schema.json](runtime-start.schema.json) | 一次执行的固定上下文、绑定、工作区、政策与预算引用 | [runtime-start.example.json](runtime-start.example.json) |
| [runtime-event.schema.json](runtime-event.schema.json) | 来源、序号、版本与关联事件信封 | [runtime-event.example.json](runtime-event.example.json) |
| [evidence.schema.json](evidence.schema.json) | 代码交付的证据类型、版本、环境与结果 | [evidence.example.json](evidence.example.json) |
| [flow.schema.json](flow.schema.json) | 不同基座并行、汇合、验证与人类批准的工作图 | [dual-model-flow.example.json](dual-model-flow.example.json) |

JSON Schema 只检查结构，不能替代身份、授权、引用是否真实、模型兼容、预算、签名、图依赖和状态检查。服务端必须根据受信身份确认 evidence_kind，客户端填写 trusted_tool_result 不能获得信任。

Draft 2020-12 schema；示例 `$schema` 不要求网络调用，校验使用本地文件。`zentwine.invalid` 是保留示意域名，不是实际服务。

推荐执行：`python scripts/validate_plans.py --validate-schemas --export /tmp/zentwine-backlog.json`。Schema 验证需要 jsonschema Python 包；普通链接/任务校验仅用标准库。校验这些示例不代表真实产品或基座测试通过。
