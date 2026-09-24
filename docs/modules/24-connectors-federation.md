# ZT24｜连接器、工具网关与联邦同步

状态：Planned。负责人职责：集成、后端、安全、平台。依赖模块：ZT02、ZT03。对应蓝图：18.3–18.5。

## 目标

连接代码、设计、文档、任务、消息、日历、客服、分析、CI、云和身份系统。原生与外部系统共同工作，不要求客户重复维护两套状态。各对象/字段显式配置权威来源。

## 数据与接口

ConnectorProfile(capabilities,version)、Connection(credential_ref,scopes)、ExternalMapping、FieldAuthority、SyncCursor、Conflict、ToolInvocation、ConsentRecord。

ConnectorPort 区分 read/propose/create/update/delete/deploy；MCP 作为可选工具协议而非整个控制面。平台授权 token 不能透传成外部任意 API 权限；工具返回也不是指令。[S07]

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT24-01 | ZT02-02、ZT03-02 | 实现连接器注册、能力、认证引用、scope 与数据区域配置 | 每能力单独授权；未验证操作明确 unavailable；无硬编码共享凭据 |
| ZT24-02 | ZT24-01 | 实现工具网关、schema 校验、授权、出站控制、幂等和审计 | 任意 URL/参数不能变成通用提权代理；越权工具返回不能诱导执行 |
| ZT24-03 | ZT24-02 | 建立 read/change stream/webhook/poll 标准端口及健康监测 | 验签、重复/乱序/漏事件与限流恢复有测试；断开连接停止同步 |
| ZT24-04 | ZT24-03 | 实现字段权威映射、同步游标、冲突队列和人工/规则解决 | 两系统同时改同字段不会互相覆盖或无限回环；有 old/new/source 证据 |
| ZT24-05 | ZT24-04 | 实现任务/设计/文档/消息/日历/分析/CI/监控的参考适配与 SDK | 每类有真实接口核验和契约报告；不把所有连接器图标等同已支持 |
| ZT24-06 | ZT24-05 | 完成联邦迁移、断连撤权、版本升级和连接器 conformance 套件 | 退订/删连接后 Key 与派生访问失效；远端操作未知先对账；客户数据可迁出 |

## UI 与治理

连接中心显示真实 scope、最近同步、延迟、错误和权威字段。工具审批展示外部目标和实际动作。发送客户/群消息按身份政策确认，不因会议总结自动作出对外承诺。

## 完成定义

每条连接器能力分别标 planned/tested/deployed，只有目标版本的真实集成通过才可对外宣称支持。新适配器可独立发布但要兼容平台契约和撤权机制。
