# 质量政策与冻结基线

## 适用范围

继承 [根约定](../AGENTS.md)。快照、限额、历史测试保护与依赖基线不是普通报错消音配置。

已有 API/schema/迁移历史不覆盖；凭据扫描排除只能是可解释的合成样本，新增排除不能在同一普通 PR 自行批准。不得隐藏真实泄露或记录凭据值。

要调整保护先说明误报证据、风险与回退并补正反例；不能放宽要求让阻塞 PR 直接通过。

运行 `pnpm quality:check`；涉及 gate 同时保留 Python/Node 测试和实际集成。更多说明见 [质量指南](../docs/development/quality-gates.md) 与 [CI 约定](../.github/AGENTS.md)。
