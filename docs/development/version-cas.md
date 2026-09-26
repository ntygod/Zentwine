# ZT03-02｜内容修订与并发命令

状态：Blocked／Draft；当前0009被原迁移门禁拒绝，尚不可按正式流程安装或合并。最终验证见 Issue #32 对应 PR。基线为 ZT03-01 已合并主线 `4cda38a41bcbf76856bc8c9a801525c9482037cd`。

## 内部边界

这是服务器内部原语，不是新的 Spec/Project 服务、公开 API 或页面。`TenantUnitOfWork.versions` 复用已验证的人类会话和组织事务；Agent/Service 身份适配、领域细粒度资源授权和执行审批均未在本接口实现。调用模块必须在同一受控流程中检查对象及关系目标的业务权限；组织级 RLS 不代表可以公开本组织全部资料。

数据库仅保存内容描述符、修订谱系、不可变状态快照及版本关系，不保存正文或万能 JSON 内容。`content_hash` 是受信服务器对规范化内容的声明，数据库不验证外部内容存在或可读取，也不是签名。内容拥有模块负责验证 schema、持久保存正文并在使用时通过 `verifyContentDigest` 核对摘要；不要把摘要当访问凭据。

## 安装及连接

以下为候选的目标安装方式，不代表当前可执行验收；原门禁仍拒绝0009，禁止跳过校验安装。

先安装 0001–0008；0009 使用与 0008 相同的受控、无登录、无超级用户及无 BYPASSRLS 的迁移 owner 安装。不要把生产/身份/组织管理连接当作租户运行连接。按照既有专用开发库迁移流程应用 manifest，之后运行 `pnpm versions:admin` 并从标准输入传入 `{"action":"grant-runtime"}`。该命令继续要求 `ZENTWINE_IDENTITY_OPERATOR_ACK=local-development-only` 及既有操作员连接配置，只为既有 `zt_tenant_app` 追加必要 SELECT 和命令 EXECUTE 权限，不创建账号、不迁移或自动创建内容。

0009 运行账号不能直接 INSERT/UPDATE/DELETE/TRUNCATE 版本表。`versions` 操作在原租户账号检查之外复核新 schema/表/函数所有权、强制 RLS、函数 owner、列级及破坏性权限误授。没有安装或授权时失败，不静默降级到无隔离存储。控制面旧表继续使用原实现。

## 摘要格式

`digestContent(schemaId, validatedContent)` 使用 `zt-json-v1`，而不是声称支持全部 RFC8785。允许 null、布尔值、有效 Unicode 字符串、安全整数、密集数组与纯数据对象。按 UTF-16 排序原始对象键，不按本地语言排序；不做 Unicode NFC/NFD 转换；数组顺序保留。拒绝小数、负零、NaN/Infinity、不安全整数、undefined、BigInt、稀疏数组、循环、访问器、非数据对象和 symbol。上限为 65,536 个规范化 UTF-8 字节、32 层深度、4,096 个访问节点。

输入是已解析且经过领域校验的 JSON 数据；若来自原始 JSON 文本，领域解析器必须自行拒绝重复键，不得指望本函数恢复已经丢失的重复键。受信服务器代码不得传入带副作用的 Proxy。

摘要为 SHA-256，输入字节为 `zentwine.content-digest.v1`、零字节、schema ID、零字节、规范化版本、零字节、规范化内容。`content_bytes` 只记录最后一段的 UTF-8 字节长度。schema 或规范化版本变化不能隐式复用旧摘要；将来扩展格式须新增明确版本，不能改变 v1 的既有结果。精确的小数可以由领域使用受校验的十进制字符串表示。

## 内容版本与状态版本

每个对象都有单调递增 `object_version`；每次成功命令只新增一个状态快照，旧行从不 UPDATE。`revision_id`/`revision_number` 只在显式 `revise` 时新增，包含父修订、内容描述符、创建人和时间。提交评审与批准保留相同内容修订，只增加状态版本及操作人。批准后内容、关系、批准快照保持不变，不能改写草稿来影响已批准事实。

状态规则：不存在/draft/superseded 可 `revise` 成新 draft；draft 可 submit 成 in_review；in_review 可 reject 回 draft 或 approve 成 approved；approved 可 supersede 成 superseded，approved/superseded 可 retire 成 retired。retired 终止本对象链。approved 不接受直接 revise，必须先显式 supersede，再创建新修订。

所有写命令要求有效内部成员，approve/reject/supersede/retire 要求当前负责人；approve 还要求当前操作人与内容修订创建人不同。该批准标记只是基础库的人类评审事实，不是 ZT02 的策略审批、执行许可、工作包完成或生产发布；后续模块可以附加更严格规则，不得反向放宽基础保护。

## 调用示例

```ts
import { digestContent } from "@zentwine/db";
const content = digestContent("spec.content.v1", validatedDomainContent);
const result = await tenantRepository.transaction(scope, async (unit) => {
  // 领域模块应在此受控流程中完成具体业务权限/输入检查。
  return unit.versions.command({
    object_id: registeredObjectId,
    expected_version: displayedVersion, // 首次为 0；不可盲目替换为服务器最新值。
    action: "revise",
    content,
    relations: [], // 必须明确选择，本次不继承旧修订的关系。
  });
});
```

状态命令传入同一对象、expected_version、action、精确 revision_id 及 content_hash。`head(id)` 读取当前快照，`snapshot(id, objectVersion)` 读取精确历史状态；`relations(id, revisionId)` 读取该内容修订的关系。读取为租户隔离的内部查询，不启动执行。单次关系最多 32 条。

## CAS、失败与重试

每个对象的变更先取得组织范围对象锁，然后重新读取当前状态和权限，再比较 expected_version 及状态命令的修订/摘要。锁后查询采用 READ COMMITTED 下新的数据库语句视图；同一旧版本的两个有效命令最多一个成功。不依靠客户端时间、进程内锁或默认最后写入获胜。批次多对象事务的锁顺序由可信调用方按对象 ID 排序；数据库死锁或连接故障只返回安全错误，不自动重试。

命令结果为 `applied`、`conflict` 或 `invalid_transition`，并返回 expected_version 与当前授权范围内快照（尚未建立版本时可为 null）。冲突结果是数据，只有在外层事务最终权限复核通过后才能返回。该命令的冲突/非法转换不产生版本写入；若调用者此前执行了其他成功命令，它必须检查结果并显式抛错来要求整个组合事务回滚，不能忽略结果后假定批次全部成功。

网络提交结果未知时禁止自动重发。相同旧 expected_version 再次提交会冲突，而不是伪装幂等回执；Operation 对账属于 ZT03-04。异常、被吞异常、未等待的操作、逃逸事务端口继续沿用 ZT03-01 的回滚/排空保护。提交前不能产生外部副作用；已返回给可信回调的内存数据不能撤回。

## 版本关系

关系保存 kind、来源描述（declared/derived）、目标对象、目标 revision_id 和 target_hash；本组织是明确范围，主体修订从新建版本确定。两侧复合外键和 RLS 阻止跨组织关联。来源描述不授予权限。目标后续产生新版本不会让旧关系自动追随；更换关系必须创建新修订，即便正文摘要相同，也产生新的 revision_id，旧批准元组无法批准它。兼容性、影响传播、循环依赖和领域关系语义由后续模块负责，不在这里推断。

## 回退与验证

0009 未使用时可在事务内回退；任何内容修订/状态/关系已存在时 down 拒绝，并回滚对 FORCE RLS 的临时变更。使用向前修复，不以降级擦除批准历史。未来删除/保留挂钩属于 ZT03-05，当前未提供不可撤销永久保留的产品政策；数据库管理员仍是可信边界，不声称能抵御恶意迁移 owner。

`pnpm test:versions` 执行规则、摘要和事务自测；`pnpm test:versions-integration` 使用既有专用临时 PostgreSQL 配置。缺配置返回 1，不跳过集成。CI 必须同时执行原始完整回归，任何最终文档变更也要复验。未调用真实模型、部署或迁移业务库。

阻断记录：函数体BEGIN的门禁兼容扩展写入被工具拦截，未换通道重试；候选保留原校验器及其拒绝行为。新增规则单测通过不代表数据库或完整回归通过，当前只能审阅候选实现，不能合并或将其作为可安装功能交付。
