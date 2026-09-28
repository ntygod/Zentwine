# 共享包

## 适用范围

继承 [根约定](../AGENTS.md)，适用于 packages 子树；更深层约定按目标路径读取。

## 依赖方向

[边界规则](../scripts/check-boundaries.mjs) 是可执行依据。domain/contracts/config 不依赖其他包；policy 只依赖 domain；client 只依赖 contracts；UI 使用 client/contracts；db 使用 domain/policy/pg。Node 内置模块也受边界白名单约束。

从包公开入口导出，禁止跨包相对路径、计算型动态导入、供应商类型泄漏到领域。对外 schema/枚举/状态变化先确认兼容性，不覆盖已发布版本快照。

runtime-core、runtime-claude、runtime-codex、connectors 目前是规划占位。现有运行协议在 contracts，观察/交接逻辑在 client；不要把新代码随意塞进占位目录后宣称基座已接通。

## 验证

`pnpm check` 构建并检查全部包；契约变化加 `pnpm contract-check`。使用真实消费者和新增失败样本验证公开接口，保留既有黄金样本。范围/状态见 [实施状态](../docs/tasks/status.md)，全包扩张需先记录 ADR。
