# ZT02｜身份、组织与授权内核

状态：InProgress（完整产品与通道验收未完成）。ZT02-01至ZT02-05限定实现验收见[实施状态](../tasks/status.md)；ZT02-06的A权限矩阵、B只读审计、C应急控制已分别合并PR #26/#27/#28，B文档在本次文档PR补齐并须完整复验。[执行记录](../tasks/ZT02-06-execution.md)区分已交付范围与[尚未实现的文件/预览/导出验收](../tasks/zt02-06-acceptance-followup.md)。负责人职责：后端、安全、前端。依赖模块：ZT01。对应蓝图：02、13、19。

## 目标

支持个人、团队、多组织与受限客户协作；人、Agent、服务分别有可审计身份。基础安全不是高级付费能力。完整企业 SSO/SCIM 在同模块后续任务实现，不从终态删除。

## 数据与接口

Organization、Team、Membership、HumanIdentity、AgentIdentity(accountable_owner)、RoleBinding、ResourceGrant、Delegation、PolicySnapshot、Approval。租户字段来自可信身份上下文。

拟建 `/memberships`、`/role-bindings`、`/delegations`、`/approvals/{id}/decide`、`/policy/evaluate`；事件 membership.revoked、policy.changed、approval.decided。策略决策返回 allow/deny/needs_approval 与理由、版本、到期，不只 boolean。

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT02-01 | ZT01-03 | 建立组织、身份、会话和成员关系；API session 校验及租户上下文中间件 | 两租户相同显示编号不会串数据；切换组织重新检查会话和权限 |
| ZT02-02 | ZT02-01 | 在 policy 包实现角色＋资源＋动作＋环境规则，API/工具端共同调用 | 直接 HTTP、WS、工具调用均受限；默认拒绝未知动作；前端隐藏不是唯一防线 |
| ZT02-03 | ZT02-02 | 建立 Agent 身份、责任人、父子授权、有效期和 PolicySnapshot | 子授权不能扩大资源/预算/期限；父撤销后子不能继续获取工具权限 |
| ZT02-04 | ZT02-03 | 实现版本绑定审批、职责分离、短期动作许可及撤权通知 | 重放批准、换内容 hash、换环境、过期批准均拒绝；记录人工和预授权策略区别 |
| ZT02-05 | ZT02-01、ZT02-02 | 实现组织设置、访客、SSO/SCIM 端口和邀请回收，配置迁移及会话撤销 | IdP 禁用成员传递到资源和活动连接；外部访客看不到组织私有搜索结果 |
| ZT02-06 | ZT02-04、ZT02-05 | 建立权限测试矩阵、审计视图、应急撤权与策略回归工具 | REST/WS/搜索/文件/预览/导出覆盖跨租户、降权、缓存旧授权和并发撤销 |

## 状态与异常

身份停用不删除审计责任记录；服务故障时关键动作 fail closed。审批与业务状态转换同一核验路径，不能先执行再补审批。已经发送给供应商的内容无法靠撤权回收，应显示范围并阻断后续发送。

## 完成与观察

记录拒绝原因、策略版本与撤权传播延迟，不记录秘密。灰度先影子评估而不扩大权限，再对受控组织启用；异常回到更保守策略。所有场景通过真实资源边界测试，不以菜单截图代替。

## 已实现接口与原目标的区分

上表保留完整目标，不能将拟建路径视为已发布接口。当前组织审计实际为 `GET /api/v1/orgs/:orgId/audit-events`，应急控制实际为 `GET/POST /api/v1/orgs/:orgId/members/:memberId/emergency-access`；分别见[审计指南](../development/organization-audit.md)及[应急指南](../development/emergency-containment.md)。

当前审计是十一类组织事实投影，不覆盖登录失败、完整资源/Agent/审批轨迹及通用对象历史；文件/预览/导出实际业务仍不存在，ZT02-06严格矩阵退出2。已有模块支撑代码和文档交付不改变这些验收边界。下一独立工作包ZT03-01按其明确前置ZT02-01推进，本模块不能为满足依赖而虚标完整Done。
