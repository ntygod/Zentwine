# ADR-013｜Agent身份、收窄授权链与调用额度

状态：Accepted for local development。工作包ZT02-03。日期2026-09-25。依据项目负责人既有委托进行决定；不是独立第三方安全认证。

## 决定

Agent身份与人类身份分离，每个Agent绑定不可转让的accountable_owner_id和组织。人类会话只能创建自己的Agent及根授权。根授权须被当前人类资源策略全部允许；需要审批的动作不得进入授权。子Agent预先由同一责任人登记，父Agent只能为它签发更窄的授权，不能创建新的人类身份或组织角色。

每个凭据只对应一条Delegation，32字节随机值仅在首次签发返回，数据库保存SHA256摘要。持久Delegation记录parent/root及不可变PolicySnapshot。原始凭据不放在URL、Cookie、日志或快照；Agent接口不接受浏览器Origin/Cookie。仅本机开发HTTP，不是生产凭据传输方案。

资源以稳定ID逐项列举，并各自绑定动作与环境。子级必须是父级子集，起点不能提前、终点不能延后、可继续委派深度必须减少。上限为8层、16个资源/授权、128个节点/根树、8小时。禁止同一Agent再次出现在祖先链中；同一Agent可以拥有独立根授权，但不能合并凭据形成更大的权限。

每次调用重新读取完整祖先链、Agent、责任人、组织、成员和当前资源策略；在取得锁之后重新看时间。任一祖先撤销/过期/停用导致下一次调用失败。责任人auth epoch、成员版本、组织版本与策略revision绑定到快照；变化后保守地要求新根授权，不自动复活旧链。普通资源名称变化不使授权失效，当前动作使用最新资源版本CAS。

## 预算

本工作包的预算单位是**成功的目录工具调用次数**，不是Token、人民币或供应商账单。子级分配立即占用父级reserved_calls；当前节点可用额=max_calls-reserved_calls-used_calls。子级执行只消费子额度，父级已预留额不重复记消费；由此每棵树的总消费受根额度约束。并发兄弟分配与消费采用同一组织级事务锁；不会每个子节点都复制一份可花预算。

撤销不自动退还额度，不复用未知结果的额度。该保守策略允许闲置但不超支，退款/资金与多维预算在ZT26扩展。成功目录读/改名消费1次；验证失败不消费；数据修改、扣减和操作回执在同一事务。request_id重复只返回历史回执，不重复执行；重放之前仍检查撤权及当前读取资格。

## 快照与生命周期

快照采用sorted-json-v1规范化和SHA256完整性索引，保存责任人/Agent/组织/成员/策略版本、资源版本和授权边界。运行角色只能新增/读取快照，不能改写/删除。摘要不是签名，数据库管理员不在该边界之内。快照不是可复用执行许可证。

授权独立于发起人的浏览器会话：明确委派后，浏览器退出不自动取消工作；停用身份、组织失效或撤销授权阻断后续调用。独立授权不是偷偷延长会话。签发响应丢失，重复request_id返回记录但不返回原秘密；人类可撤销该记录并以新request_id重新签发。

## 一致性与代价

共同锁顺序：人类入口session行 → human → organization → membership → policy → agent-tree(org) → resource行。Agent入口从持久凭据解析责任人/组织后采用同样顺序（不持人类会话锁）。READ COMMITTED新语句在等待后读取；已取得授权锁的操作可先提交，撤权等它完成再返回；不能撤回已经返回的数据。

组织级串行是明确的开发期代价，不是高并发终态。后续可以在保证同样顺序及额度账本正确性的前提下细化到根树；不能只删锁换取吞吐。数据库控制面受信任，Agent代码不得持有连接池或构造原始scope。HTTP及绑定工具没有任意执行回调，当前仅catalog.read/catalog.rename真正执行。

## 验证与回退

新增纯规则/API、真实PG/HTTP/绑定工具和loopback TCP验证；不改写旧测试。关闭ZENTWINE_AGENT_MODE即可停用入口并保留数据；0003 down仅用于明确销毁开发数据，不能自动对业务库执行。身份/权限界面、真实模型、SSO、审批签发、生产部署及OS隔离未在本工作包完成。

## 参考

- [RFC 8693 §1.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-1.1)：区分代理者与其代表的主体。本实现不是OAuth Token Exchange兼容实现。
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)：默认拒绝与每请求授权。
- [PostgreSQL 17 Explicit Locking](https://www.postgresql.org/docs/17/explicit-locking.html)：事务级advisory锁与合作式边界。
