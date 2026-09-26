# ZT03-02-A｜内容摘要与版本命令基础库

本增量只提供同步的规范化、摘要、输入快照、类型与状态转换参考规则。它不依赖0009，不连接数据库，不提供并发写入、审批、正文持久化或新HTTP/UI。ZT03-02整体仍未完成；数据库CAS、不可变存储、触发器及32项PG验收继续留在草稿PR #33和Issue #32。

## 使用

先执行既有 `pnpm build`。服务端使用 `@zentwine/db` 的 `digestContent(schemaId, value)` 和 `verifyContentDigest(descriptor, value)`；这里仅适配Node内置加密模块，调用本身不访问数据库。纯领域侧使用 `@zentwine/domain` 的 `canonicalizeContent`、`snapshotRevisionCommand`、`nextRevisionStatus` 和相关类型/验证器，没有新增包依赖。

```ts
import { digestContent } from "@zentwine/db";
import { snapshotRevisionCommand } from "@zentwine/domain";

const command = snapshotRevisionCommand({
  object_id: objectId,
  action: "revise",
  expected_version: 0,
  content: digestContent("spec.document", { title: "Example" }),
  relations: [],
});
// command是已验证、深度冻结、与原输入脱离的值，不是已提交的版本。
// 持久化实现尚未接入；不要调用不存在的tenant.versions或发出执行动作。
```

`snapshotRevisionCommand` 在任何异步等待之前同步复制并验证完整命令，拒绝额外权限字段，冻结内容描述符、关系数组及每个关系。调用方修改原对象不改变快照。低层validate函数面向已解析的可信记录；对任意内存对象的入口使用snapshot函数，不依赖TypeScript的readonly防止运行时修改。

`nextRevisionStatus` 只回答转换形状是否有效，不检查组织、会话、负责人、自批、最新版本或数据库状态；它的返回值不能作为批准、授权或执行许可。`RevisionUnitOfWork` 仅是未来持久实现的端口契约，本增量未将其挂入已有TenantUnitOfWork。

## zt-json-v1与摘要

支持null、布尔值、字符串、安全整数、密集数组及普通或null原型对象。对象键按UTF-16顺序排列，数组顺序保留；不做Unicode正规化，不调用toJSON。拒绝负零、非整数、NaN/Infinity、未配对代理码元、undefined、BigInt、符号、自定义对象原型、访问器、不可枚举属性、稀疏数组、附加数组字段与循环引用；共享但无环的子对象按值序列化。

最大规范化UTF-8字节数65536；根深度为0，最大32；最多访问4096个值，键不单独计为值。包括引号和转义后的字节数。调用者仍须在解析前限制原始请求大小，本库不是不可信JS对象/Proxy的沙箱；反射操作可能触发Proxy trap。重复原始JSON键在解析前由领域解析器拒绝，本库无法从已经折叠的对象恢复重复键。

哈希输入是UTF-8编码的 `zentwine.content-digest.v1`、NUL、schema_id、NUL、`zt-json-v1`、NUL、规范化正文。schema_id使用现有受限命名格式，不能包含NUL。content_bytes只统计规范化正文，返回值仅含algorithm、canonicalization_version、schema_id、content_hash、content_bytes，不保存正文。

格式有效但正文/schema/字节长度不匹配时verify返回false；描述符或输入不支持时抛出固定invalid_input。摘要不是身份认证、签名、批准，也不证明外部正文已存在或持久化。本规范是受限JSON子集，不声明完整RFC8785兼容，新增浮点等类型必须另设规范版本。

## 版本与关系契约

内容revision和状态object_version分别建模。revise、submit、approve、reject、supersede、retire具有有限转换表；批准内容不允许直接revise，必须显式supersede。保护转换的角色/作者约束仍须未来数据库实现重新检查。

命令必须提供expected_version；状态动作同时绑定revision_id与content_hash。关系必须包含kind、declared/derived来源、目标对象ID、精确修订ID和摘要；最多32条，同kind/source/目标对象/目标修订不允许重复，即使摘要不同。空数组是明确输入，不隐式继承旧关系。这里仅验证结构，不查询目标、判断跨租户权限或证明关系成立。

## 验证与交接

`node --test tests/version-primitives.test.mjs` 运行新增规则、摘要和快照测试；`pnpm check` 通过原有测试发现规则自动包含它。固定黄金样本位于 `tests/fixtures/version-primitives-vectors.json`，由独立Python UTF-16键排序及hashlib生成后固化，Node测试不动态重算预期摘要。覆盖8个黄金样本、36个状态/动作组合、键顺序、Unicode、大小/深度/节点限额、访问器拒绝、关系重复和输入隔离。

本次不修改scripts/quality/gate.py、scripts/quality/migrations.mjs、CI工作流或0001–0008迁移；不纳入0009或PR #33的数据库写入口。既有完整CI仍须在本增量的精确提交执行，最终日志、制品摘要、合并及源码树以对应PR为准，不沿用历史绿色。原PR #33仍需先解决迁移兼容，整合本库、消除重复定义，再实际完成数据库和全部回归；A的通过不能替代这些条件。
