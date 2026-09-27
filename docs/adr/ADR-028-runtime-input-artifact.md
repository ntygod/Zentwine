# ADR-028：运行输入产物的本地字节完整性与一次性交接

状态：Accepted（实现约定；精确提交验收与合并见PR #54）；任务ZT12-01-A4，Issue #53，父Issue #46。

## 决定

在已合并wire1.0.0、事件观察器和字节流消费者之上，新增`RuntimeInputArtifactReader`。消费者StartRun中的精确输入引用是选择依据；生产者manifest中的组织、Run、Attempt、artifact_id、revision、sha256及来源必须一致。清单本身继续是`unverified`，不把摘要声明或字节匹配当授权、作者认证或可信代码验收。

读取宿主已取得并授权的原生ReadableStream，实际原始字节保持二进制，不做换行/编码/JSON规范化。必须读到EOF且长度精确，再用平台Web Crypto的SHA-256核对。成功后只允许`takeBytes()`一次性转交这份私有字节，不允许“核对后再下载”作为本接口的交接路径。

默认每实例最多4MiB、65536个字节块，均只能降低；空块也计数。声明长度超限在读取前拒绝。失败及close/Abort擦除本实例仍拥有的缓冲区；等待底层读取或摘要时可本地中断，不等待源cancel完成。取消监听在matched之后继续有效，直到显式取走或关闭，避免读取完成和交接之间遗留可领取数据。

## 代价与边界

Web Crypto digest接收完整BufferSource并复制字节，而非流式增量接口，因此先有界缓冲再摘要，不手写密码算法。限制不等于整个JS堆或网络收包上限，平台密码操作中的副本不可由本类保证擦除。更大文件需要独立的受审流式摘要/存储实现，不提高本上限冒充可用。

所有权转交后字节可由调用方修改，快照只描述检查时刻；本类不能擦除调用方副本、禁止执行字节或撤销已经发生的副作用。多个实例不是全局一次性交付/持久去重。宿主负责响应状态、类型、可信来源、授权/撤权/期限、引用真实性、存储及执行策略。没有URL、隐式fetch、持久化、运行启动或供应商调用。

## 验收与回退

以独立SHA-256黄金值、原生Web流、精确引用及容量、异常属性、待读/待摘要取消和真实loopback HTTP验证。故障注入摘要测试单独标注，不替代实际密码实现正例。旧协议/观察器/流读取器及旧门禁不修改；回退为移除此新增入口，不需要数据库回滚。Issue #32/#35与DraftPR33仍Blocked，不替代其维护者审查。

## 依据

W3C Web Crypto `digest`复制输入字节并异步返回摘要：[规范](https://www.w3.org/TR/webcrypto/#SubtleCrypto-method-digest)。WHATWG原生reader的读取、取消与锁释放：[Streams](https://streams.spec.whatwg.org/#rs-default-reader-class)。这些是平台机制依据，不是本实现的独立安全认证。
