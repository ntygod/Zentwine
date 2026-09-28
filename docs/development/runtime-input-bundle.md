# 多生产者输入整批准备

ZT12-01-A6 / Issue #57。`RuntimeInputBundle` 从 `@zentwine/client` 导出；只准备固定消费者 `StartRun.input_artifacts` 的全部原始字节，不准备整个上下文，也不授予执行权限。

## 调用顺序

```ts
const bundle = new RuntimeInputBundle(consumerRequest, [
  { request: producerARequest, manifest: producerAManifest },
  { request: producerBRequest, manifest: producerBManifest },
]);
bundle.begin(lifetimeAbortSignal);
await Promise.all([
  bundle.observeProducer(producerAManifest.manifest_id, authorizedEventsA),
  bundle.observeProducer(producerBManifest.manifest_id, authorizedEventsB),
]);
// 先检查 status === "awaiting_artifacts"，再由宿主取得已授权的字节流。
await Promise.all([
  bundle.readArtifact(inputAId, authorizedBytesA),
  bundle.readArtifact(inputBId, authorizedBytesB),
]);
// 仅 status === "ready" 时允许领取；每个 input_artifacts 条目都须被准备。
const delivery = bundle.takeAll();
// 此处只完成字节交接。执行前仍需宿主的授权、版本、租约与策略检查。
```

多个生产者可并行观察，多输入可并行读取；对同一条目只允许一次调用。所有生产者通过前不接受任何字节流。每生产者只读一次事件流，即使提供多份输入。生产者清单可包含未选中输出，但完整报告仍须与其精确集合一致；每个提供的生产者必须至少贡献一个消费者输入。

构造时同步解析并冻结消费者及生产者的 request/manifest，检查全部输入精确覆盖、唯一生产者流与清单 ID、组织、来源及 revision/hash。封闭数组/包装对象只接受自有可枚举数据属性，不调用普通 getter。空输入要求空生产者表，显式 begin 后只能交出空数组；仍验证消费者。

## 整批生命周期

`idle → awaiting_producers → awaiting_artifacts → reading_artifacts → ready → taken`。无输入时由 idle 经 begin 直接 ready。每个生产者由既有 A5 组合器核对完整 EOF、连续成功报告、清单 ID 和产物集合；字节由既有 A4 读取器校验 EOF、精确长度和原生 SHA-256。没有外部快照导入捷径，不改旧协议/读取器。

takeAll 是同步的一次性全部转交，输出顺序为消费者的 input_artifacts 顺序，与并行完成顺序无关。没有按单份提前领取的 API。任一生产方或字节失败会进入 rejected，关闭所有子读取器，擦除仍拥有的内容并取消其他待读，迟到结果不恢复。显式 close 再清空身份和计划。失败只返回固定错误码与调用方已知的条目 ID，不回显来源错误。

begin 绑定的原生 AbortSignal 覆盖阶段间等待、并行读取、待摘要及 ready 到领取窗口；拒绝/关闭/取走后移除监听。底层 cancel 不完成也不阻塞本地收尾。未被方法取得的来源仍归宿主管理；构造时已经创建的外部流可能自身有副作用，本库不会撤销它们。

## 容量与信任

固定上限：16 输入、8 生产者、16MiB 声明总字节；三个完整预算字段只能降低。每份仍受 A4 的 4MiB/65536 块上限和 A3 的事件流限额约束。先检查声明总量，再取得任何来源。事件容量是每个生产者的原上限，不表示总网络、平台密码副本或整个 JS 堆的大小；宿主仍负责截止时间、认证和总资源管理。

交付始终 authorization:false、verification:unverified、producer_report.trust:reported_not_authenticated。全部字节校验不是来源认证、代码安全、任务完成或启动许可，不包含其他上下文引用的内容。原始字节转交后可变，关闭不能擦除调用方副本；平台 Web Crypto 副本不承诺擦除。本类不是不可信代码/恶意 Proxy 沙箱，也不是跨实例事务、持久一次性交付或调度器。

无 URL、自动 fetch、模型、Storage、进程、定时器或重试接口。宿主负责真实 HTTP 状态/类型/重定向与授权，失败后不能以新实例自动重新执行。原版本持久化和真实适配阻断仍按父任务处理。
