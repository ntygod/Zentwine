# 运行输入产物字节读取（ZT12-01-A4）

状态：限定实现，最终精确提交验收与合并见PR #54 / Issue #53。不是生产产物存储、可信Verifier或真实模型适配器。

## 使用

从`@zentwine/client`导入`RuntimeInputArtifactReader`和`RUNTIME_INPUT_ARTIFACT_LIMITS`。构造函数参数依次为消费者StartRun、生产者ArtifactManifest、所选artifact_id和可选的完整限额对象`{max_bytes,max_chunks}`。两个结构由既有公开contracts解析器同步复制并深冻结；生产者引用必须与消费者input_artifacts精确相同，synthetic和provider来源不能混用。

```ts
const reader = new RuntimeInputArtifactReader(consumer, manifest, artifactId);
try {
  // body已由宿主取得并鉴权；此库不调用fetch、不验证HTTP响应头。
  const result = await reader.read(body, abortSignal);
  if (result.status !== "matched") throw new Error("Artifact unavailable");
  const delivery = reader.takeBytes();
  // 将delivery.bytes交给后续受授权消费者；不要再次下载其他字节来替代它。
  // authorization仍false，delivery.binding.artifact.verification仍unverified。
  consumeLocally(delivery.bytes);
} finally {
  reader.close();
}
```

上述函数名body/consumeLocally为宿主提供的变量/函数，不是已有运行API。打开界面、读取或取走字节都不能自动启动Run。即使来源为adapter_report，也只是声明与收到字节的对应，不是供应商认证。不同组织/生产Run/Attempt/revision/hash、缺失/重复引用、未知版本和额外字段拒绝。

## 状态和所有权

`idle → reading → checking → matched → taken`。读取及摘要错误进入`rejected`，close/Abort进入`closed`且清空当前绑定和计数。所有状态都有`authorization:false`。快照不含原始字节，故障只用固定枚举，不返回源异常或Abort原因。

只有完整EOF、精确size_bytes和SHA-256相符才设置`integrity:sha256_and_length_match`。恰好收到声明长度但源未关闭时仍不可领取；多一字节、少一字节或同长度损坏都拒绝。原始编码/换行/二进制不被转换；media_type是清单声明，不是内容识别。

`takeBytes()`只在matched可调用一次，返回冻结外壳和可变Uint8Array，移交的是同一份已检查私有缓冲区。已读取的源块会复制，不与交接字节共享源缓冲。不得把取走之后的可变字节或旧快照当作永远有效的完整性证明。旧副本不能远程擦除；close不会清除已交给调用方的字节。

read每实例一次，失败后也不重用；第二次读取不抢占其他流的锁。预取消不获取reader；等待read或digest时取消可立即结束本地等待，底层cancel拒绝或不返回也不阻塞。matched之后Abort仍会销毁尚未取走的字节；take/close/失败移除监听。宿主必须在take前重新核对授权，需要时主动close，不以此库代替授权失效监测。

## 限额和平台

默认max_bytes=4194304、max_chunks=65536，完整配置只能降低为正安全整数。声明大小在读取前检查；实际块在复制前检查，空块计数。超限不截断后当作有效产物。received_bytes/received_chunks只统计成功接受的块，拒绝的超大块不计入，不是网络收包计量或账单。

使用原生Web Crypto SHA-256，无自定义摘要算法/注入认证钩子；缺失或失败返回digest_unavailable。平台digest非增量，最多有界缓冲及其平台副本，不承诺总堆上限或密码实现内部擦除。read没有自动超时，宿主用可信AbortSignal控制期限。共享/已分离缓冲和非Uint8Array拒绝；普通块属性getter不调用，不防御恶意Proxy或被篡改的平台。

## 复现和保留边界

冻结安装和build后：`node --test tests/runtime-input-artifact.test.mjs`；全运行相关回归：`node --test tests/runtime*.test.mjs`。本机HTTP测试用合成内容连接临时loopback端口，不涉及真实模型、身份或客户数据，服务端write边界不保证等于网络分片；强制分片另由原生Web流验证。

没有持久写入、跨实例领取记录、正文版本CAS、产物权限API、沙箱执行、任务验收或远端停止。父Issue #46和#40/#25/#32/#35、DraftPR33保持各自未完成边界。原A/A2/A3验收记录不因本能力改变。
