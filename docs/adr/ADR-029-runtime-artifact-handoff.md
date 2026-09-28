# ADR-029｜报告与字节绑定的单产物交接

状态：Accepted（限定本地组合；最终验收与合并见PR #56）。任务：ZT12-01-A5，Issue #55。基线为PR #54的main `11a9de8a3d9104f0d231e3dc1fc9ff0af0c6961b`。

## 问题与决定

事件流和字节校验分别成功，并不证明两者指向同一产物。新增客户端RuntimeArtifactHandoff，内部使用原RuntimeEventStreamReader消费生产方流，随后使用原RuntimeInputArtifactReader校验消费者选中的实际字节。不得接受调用者提供的“已验证观察快照”作为替代。

先绑定生产StartRun与manifest以及消费StartRun的精确输入引用。只有完整帧、EOF、连续succeeded报告、相同manifest_id和精确相同的artifact.produced引用集合，才允许readArtifact。集合比较不受排列影响；缺少或额外条目也拒绝。此严格集合要求是本组合器的策略，不修改wire1.0.0，也不宣称是所有未来适配器的通用语义。

只有实际选中字节EOF、长度和平台SHA-256匹配后才能一次性takeBytes。交付保留reported_not_authenticated与authorization:false；verification仍为unverified。只验证选中一个输入，不把其他清单条目或消费者的其他输入当成已下载或已校验。

## 生命周期与约束

observe接收的可选原生AbortSignal覆盖后续所有阶段，包含事件读完到字节开始、摘要检查和ready到take之间；不在单个流结束时过早脱离。close清空本实例持有的上下文并关闭两个读取器，不让迟到结果重开阶段；take后字节归调用者，旧副本不能擦除。

调用方显式供应已经取得并授权的原生流；组件没有URL、fetch、Storage、执行或重试接口。错误顺序调用不取得新流。继承原读取器的有限预算，不引入更宽限额。失败只给固定类别和已有脱敏快照，没有部分正文。期限、认证、撤权、HTTP状态、内容类型与重定向仍由宿主检查。

## 代价、验收与回退

严格集合策略会拒绝省略artifact.produced或含额外最终产物的报告；需要修正生产方报告而非静默放行。报告与摘要一致不证明来源真实、权限有效、代码安全或任务完成。没有批量原子输入、持久去重、原始JSON清单重复键防护或执行宿主；原版本持久化阻断保留。

真实公共组件的合成单测与真实loopback HTTP/固定子进程组合验收见[报告](../testing/zt12-01-a5-report.md)。固定消费进程实际核对收到字节摘要并求和，不是真实模型、沙箱或可信验证服务。

回退只撤销新导出及组合器；原协议、观察器、读取器、旧测试和数据库不改。父Issue #46仍Open；Issue #32/#35及Draft PR #33不因本增量关闭。
