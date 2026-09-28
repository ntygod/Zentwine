# 公共契约

## 适用范围

继承 [共享包约定](../AGENTS.md)。contracts 不依赖数据库、React、client 或供应商 SDK。

修改运行 wire 时读 [协议指南](../../docs/development/runtime-wire.md)；设计期示例在 [docs/contracts](../../docs/contracts/README.md)，不要混同为当前 SDK 接口。

保持 TypeScript 类型、运行时 codec、JSON Schema、合法/非法样本一致；精确版本、事件顺序、枚举和预算要失败关闭。复制并验证输入，不保留可被调用者随后修改的描述符。

`CapabilityReport` 是非授权声明；hash、版本、协议解析通过都不证明内容存在、来源可信或可以执行。v0.1 与 runtime wire1.0 不能未经兼容决定互换。

运行 `pnpm check`、`pnpm contract-check`，新增缺字段、未知字段、非法序列/大小、突变与跨版本用例。保留原 schema 路径和冻结快照；新版本另立路径/明确迁移。
