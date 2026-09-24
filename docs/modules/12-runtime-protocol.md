# ZT12｜模型、角色与运行时注册协议

状态：Planned。负责人职责：执行平台、后端、安全。依赖模块：ZT01、ZT02、ZT03。对应蓝图：08.2、18.1。

## 目标

把模型、Agent 角色、运行时、执行环境分别注册，让 Claude/Codex 等通过共同平台协议工作，但不伪装所有功能完全相同。跨供应商协作由平台承担，不由某个供应商隐藏子 Agent 体系独占。

## 模型

ModelProfile(provider,requested_model,available_regions,modalities)、AgentProfile(role,instructions,tools,owner)、RuntimeProfile(adapter,version,compatibility)、CapabilityReport(tested_at,evidence)、Binding(policy,model,runtime,environment)、Run、Attempt、NativeSession。

Capability 状态：native、emulated、unsupported、experimental、unverified。实际供应商返回模型版本不可得时记录 unknown，不拿别名当实测版本。UI 品牌按供应商指引使用，Zentwine 保持独立。[S01–S03]

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT12-01 | ZT03-02 | 在 contracts 定义 StartRun、RuntimeEvent、ArtifactManifest、CapabilityReport 和错误模型 | schema 校验与兼容 Fixture 可运行；没有供应商专属字段泄漏到业务状态 |
| ZT12-02 | ZT12-01、ZT02-03 | 实现模型/角色/运行时注册、版本、能力与授权绑定 API/UI | 不兼容或未授权供应商组合不能启动；新版本初始 unverified |
| ZT12-03 | ZT12-02 | 实现运行适配宿主、凭据引用、统一启动/观察/输入/停止/产物端口 | 前端不接触 Key；能力缺失显式拒绝；GET 不启动执行 |
| ZT12-04 | ZT12-03 | 构建 FakeRuntime，注入等待、失败、重复、乱序、失联、未知工具结果 | 所有消费者以同一契约通过，不靠解析自然语言“完成” |
| ZT12-05 | ZT12-04 | 实现适配 conformance suite、版本报告、注册禁用/回退和子执行发现 | 每适配器必须经过鉴权/拒绝/停止/费用/产物测试；未计量子执行不能获无限预算 |
| ZT12-06 | ZT12-05 | 定义真实异构验收与兼容矩阵，提供新增适配器开发文档 | 两不同模型标识可核对；实际重叠和产物消费有证据；纯 Fake 不可满足该门禁 |

## 生命周期与边界

新 Run 固定基线；重试 Attempt 不得偷偷更改模型或权限。恢复/换模型按显式新执行和检查点处理。模型内部思维链不是必需日志，保存可展示摘要、工具动作和产物。

模块提供统一协议，不负责强隔离（ZT15）、协作图（ZT16）和场景路由评估（ZT21）。公共协议变更需要所有适配器和 Studio 消费者回归。
