# 运行协议使用指南（ZT12-01-A）

状态：纯契约代码限定验收通过，最终文档提交的独立复验及合并见PR #48。没有新HTTP端点、Runner连接或可执行Run；不要把下面的解析调用当成实际运行。

## 入口与复现

依赖工作区包后从`@zentwine/contracts`导入`parseStartRun`、`parseRuntimeEvent`、`parseArtifactManifest`、`parseCapabilityReport`、`parseRuntimeProtocolError`、`bindRuntimeEvent`、`bindArtifactManifest`、`inspectRuntimeCompatibility`和`sameRuntimeRunInput`。对应类型StartRun、RuntimeEvent、ArtifactManifest、CapabilityReport、RuntimeProtocolError和RuntimeCompatibility也从相同入口导出。内部runtime-wire不属于公开API。

```sh
pnpm install --frozen-lockfile
pnpm build
node --test tests/runtime-protocol.test.mjs tests/runtime-protocol-public.test.mjs tests/runtime-wire-limits.test.mjs
python3 -m unittest discover -s tests/quality -p test_runtime_protocol.py -v
node scripts/export-runtime-protocol.mjs
```

以仓库冻结工具链为最终环境，本地其他版本仅定向诊断。Python依赖按`quality/requirements.txt`安装。导出命令只向stdout写入新协议JSON Schema；它不改已有bootstrap契约、不连接API或模型，也不生成任何批准。

合成输入在`tests/fixtures/runtime-wire-v1.mjs`，同组结构与语义正反例在`runtime-wire-cases.mjs`。其中A产物被B的input_artifacts按精确生产者、revision/hash引用，两个请求的供应商和模型标识不同；这些只是合成数据，不是两个真实模型的执行证明。

## 正确的消费顺序

先限制传输原始字节与JSON深度，再把已解析的未知对象交给本协议解析器。解析器仅同步复制JSON数据属性、拒绝多余字段并冻结副本；拒绝时只产生固定TypeError文本，不回显输入。原始JSON中的重复键已经可能被JSON.parse折叠，本接口不声称检查原始文本；需要此项的宿主必须另做严格解码。

StartRun保留任务、基线、上下文、策略、预算和租约引用；宿主还需验证数据库存在性、当前组织/主体授权、撤权、版本、租约、预算与能力报告真实性/新鲜度。`inspectRuntimeCompatibility`只匹配声明，`compatible:true`仍然`authorization:false`。报告当前绑定供应商和运行时版本，并不认证某个实际模型或环境。未通过宿主检查不得创建Run/Attempt或调用外部工具。

读取事件用`bindRuntimeEvent(start, event)`核对org/run/attempt与证据来源，收集产物用`bindArtifactManifest`。单事件合法不代表顺序合法；不得把重复/乱序/终态后的事件直接更新业务状态。事件序列是正的十进制bigint字符串，不能转换成可能损失精度的Number。实例内消费规则见下方A2指南；跨实例一致性仍须单独实现。

`sameRuntimeRunInput`忽略的只有attempt_id；对象属性顺序被codec规范，数组顺序保留。输入、权限/策略、预算或模型变化返回不相同，调用者必须拒绝复用原Run或走显式新Run流程；true也不授权重试。未知提交结果应先inspect/Operation对账，不自动重发。

## 数据语义与限制

四种消息携带独立`schema_version=1.0.0`；旧设计版本、未知消息和额外字段拒绝。使用小写UUIDv4、64位小写十六进制摘要、规范UTC毫秒时间；revision为1至2147483646。epoch/sequence/cost使用十进制字符串，最大9223372036854775807；cost允许零，epoch与sequence不允许零。安全整数用量不能为负数或负零。

能力报告需列出全部11种能力；缺失不默认为native。emulated/experimental需非空限制与证据引用，关键四能力必须被显式列入要求；unsupported/unverified不能满足要求。证据引用仅是定位，不是认证。

输入产物不能跨组织或来自同一Run。manifest内部生产者必须与信封org/run/attempt一致，一个清单不能重复artifact_id，一个产物每仓库最多一个源commit；SHA-1和SHA-256提交标识显式区分。清单当前只接受unverified，消费方不能自行升级为可信验证。

run.cancelled中的回执/范围是适配器声明，不证明进程停止；tool.requested不执行工具，approval_request_id不是批准。summary.available仅携带agent_claim产物引用，不索取私有思维链。模型观测unknown和reported分开，用量unknown、零用量及未知费用分别表示。允许的标识字符串不是秘密检测器，不得填令牌、私人会话或客户材料。

## 尚未交付

无存储、传输、订阅恢复、宿主、幂等执行、持久事件状态机、自动重试、Operation对账或真实供应商适配；不替代ZT03-02/Issue #35审查。原FakeRuntime和已有bootstrap继续保留旧限定语义。完整功能与真实异构验收见父Issue #46及ZT12后续工作包。

## 后续只读消费者

[RuntimeEventObserver](runtime-observer.md)由ZT12-01-A2 / PR #50实现，提供同一协议的实例内连续前缀、重复冲突、状态及未知观察规则；不改变本A阶段历史验收，也不代表持久事件状态机、宿主或真实适配器已完成。完整CI/合并状态见该PR。
