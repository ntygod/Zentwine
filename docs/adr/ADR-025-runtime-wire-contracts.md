# ADR-025｜供应商中立运行契约与非授权兼容声明

状态：Accepted（纯契约限定实现，代码提交完整CI通过；最终文档提交复验与精确合并以PR #48为准）。关联子Issue #47、父Issue #46；原ZT03-02前置与Issue #32/#35、Draft PR #33保留。

## 背景与选择

团队需要让不同工具和模型共享固定任务输入、运行事件和精确产物引用，而不是让一个基座的私有会话成为团队权威。按总计划的固定Fixture并行规则，先交付无副作用的纯契约；不以此越过尚未完成的版本持久化、宿主或供应商验收。

独立协议`1.0.0`定义StartRun、RuntimeEvent、ArtifactManifest、CapabilityReport及固定错误。有限codec同时给出TypeScript只读类型、JSON Schema结构和同步解析；公开入口是`@zentwine/contracts`，不公开内部codec。旧`CONTRACT_VERSION=0.1.0`、设计草案schema和FakeRuntime保持原样，没有暗示互通或替换既有运行系统。

字段封闭、显式版本、同步自有数据属性快照后深冻结；普通getter和toJSON不调用。规范JSON字节262144、节点8192、深度16的限额先于语义解析；不支持非JSON、循环、稀疏数组、符号/隐藏属性、孤立代理码和负零。不是针对恶意Proxy或已污染JavaScript运行环境的沙箱。

## 决策边界

StartRun固定组织/Run/Attempt、基线与上下文revision/hash、请求主体、工作区租约epoch、模型/运行时绑定、能力报告及要求、策略/预算引用和输入产物。权限、预算、引用存在性、租约有效性必须由后续宿主独立验证；解析成功不能启动任务。

能力为native、emulated、experimental、unsupported、unverified。必须显式接受某状态，四项核心能力start/observe/stop/artifacts不能省略；仿真和实验声明需限制造成的损失及证据引用。兼容结果始终`authorization:false`，只比较指定报告、供应商、runtime/adapter版本、证据来源和所需能力状态；不证明实际模型支持、新鲜度或证据真实性。

未知实际模型不复制请求别名，未知用量不填零；无法确认停止或工具结果时只能inspect，不自动重试。事件和产物绑定org/run/attempt及synthetic/adapter_report来源，产物固定revision/hash/生产者；模型生成摘要只能为agent_claim，产物验证保持unverified。事件顺序、状态迁移、去重、持久化和子进程停止尚未实现，十二类事件Fixture不代表合法执行历史。

## 替代方案、代价与后续

不导入供应商SDK，不暴露原生session、shell/cwd、凭据或任意payload；标识字符串仍不能自动辨认秘密，调用者须保证内容适合传播。JSON Schema仅覆盖结构，跨字段绑定、真实日历、bigint范围、重复和全局输入预算由解析器补齐。Python和Node共享正反例但使用不同验证实现，不称独立第三方认证。

不放宽原前置；完整ZT12-01仍需真实持久边界联调，ZT12-02/03没有因此具备注册API或执行宿主。未来真实适配器另行验证并采用本协议；改变公开语义需升版，不静默兼容旧草案。撤回本增量只需移除新增入口与消费点，无数据库回退。
