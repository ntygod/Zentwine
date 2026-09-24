# ZT20｜发布、运行观察与事故协作

状态：Planned。负责人职责：平台/运维、质量、业务、安全。依赖模块：ZT02、ZT18、ZT19。对应蓝图：11。

## 范围与状态

覆盖预览/测试/预发/生产、多区域/客户环境、发布计划、配置/数据库/开关清单、灰度、保护指标、停止扩量、恢复和事故调查。部署与用户启用分别记录，不在合并后宣告所有用户可用。

ReleaseManifest(repo_commits,config_hash,migrations,flags,evidence)、ReleaseAuthorization、Deployment、Exposure、ObservationWindow、Guardrail、Incident、RecoveryAction。恢复可以是回滚、关闭开关、补偿或向前修复，必须真实可执行。

API `/release-manifests`、`/deployments`、`/exposures`、`/incidents`、`/recovery-actions`；事件 release.authorized、deployment.confirmed、exposure.paused、incident.opened。

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT20-01 | ZT18-05、ZT19-05 | 实现固定版本发布清单、环境模型、前置检查和部署端口 | 每次发布可定位代码/配置/迁移/证据；旧授权不能覆盖新清单 |
| ZT20-02 | ZT20-01、ZT02-04 | 实现风险/窗口/授权/职责门禁与受控部署 Operation | 无授权不能部署；超时先远端对账；低风险允许按预授权自动执行 |
| ZT20-03 | ZT20-02 | 实现功能开关、分群/分批灰度、保护指标与观察窗口 | deployed 与 enabled 不混同；坏指标、缺观测和窗口未满有不同决策 |
| ZT20-04 | ZT20-03 | 实现暂停扩量、停止、回滚/向前修复/补偿工作流 | 不可逆迁移不能显示虚假回滚；部分成功有状态清单与处理方案 |
| ZT20-05 | ZT20-04 | 构建事故空间、多模型分服务调查、证据/假设、授权恢复及对外通知审批 | 模型猜测不标根因；公众消息不得因诊断草稿自动发送 |
| ZT20-06 | ZT20-05 | 打通效果事件、复盘、退役/下线和发布故障演练 | 观察结果返回目标；灰度异常能受控停止；恢复和旧版本兼容有证据 |

## 重要测试

发布中撤权；审批后新增提交；两次部署同 key；云 API 超时但已执行；部分区域失败；功能开关未启用；监控数据延迟；不可靠基线；数据库迁移不可逆；事故中多 Agent 争用权限。

## 交付标准

至少一个参考工程的完整预发→灰度→观察→恢复链路；文档明确不同环境权限和数据流。供应商观测故障时保留 unknown，不自动宣布健康。
