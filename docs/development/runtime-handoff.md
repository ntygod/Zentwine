# 生产报告与输入产物交接

ZT12-01-A5提供`@zentwine/client`的`RuntimeArtifactHandoff`。它组合已有事件流与字节读取器，不是运行宿主或下载器。

```ts
import { RuntimeArtifactHandoff } from "@zentwine/client";

const handoff = new RuntimeArtifactHandoff(
  producerRequest,
  consumerRequest,
  manifest,
  selectedArtifactId,
);
try {
  // 宿主先验证流来源、HTTP状态/类型、重定向、授权及期限。
  const report = await handoff.observe(producerEventBody, lifetime.signal);
  if (report.status !== "awaiting_bytes") return;
  // 只有上一步通过后，宿主才显式取得被授权的选中产物流。
  const checked = await handoff.readArtifact(artifactBody);
  if (checked.status !== "ready") return;
  const delivery = handoff.takeBytes();
  // 这里仍不是执行许可。重新核对权限、基线、期限及独立验收要求。
  // delivery.bytes是刚刚核对的同一缓冲，领取后可变且归调用方。
} finally {
  handoff.close();
}
```

上例变量代表宿主已提供的对象与流，不是仓库新增的运行API。没有自动fetch、重连、模型启动、存储或工具派发。

## 状态与检查

主路径：idle → observing → awaiting_bytes → reading_bytes → ready → taken。失败为rejected，撤销为closed；两者不能复用。同实例只observe/readArtifact/take各一次，错误阶段调用不会获取替换流；closed调用不会再检查来源字段。

构造器同步严格解析并冻结生产/消费请求与manifest。生产方组织、Run、Attempt与来源必须匹配清单；选中引用必须与消费input_artifacts中的版本、摘要、生产者完全一致。

observe内部消费实际字节流，不接收外部观察快照。完整EOF、连续succeeded、相同manifest_id和完全相同的产物引用集合才允许进入字节阶段。集合顺序不限；失败/取消报告、未知、缺口、冲突、成功后的坏尾部、未报告/被遗漏条目均拒绝。

readArtifact复用原始字节长度及SHA-256检查；失败不得取得部分内容。takeBytes返回原字节交付及producer_report（manifest_id、last_sequence、event_count、trust:reported_not_authenticated）。scope固定为one_selected_artifact，不代表其他输入已经满足。

observe的原生AbortSignal持续有效直到失败、close或take，不在事件EOF后提前移除。它覆盖阶段间等待、字节读取和摘要等待、ready后未领取的窗口。取消本地流不等于远程进程停止；close不能擦除以前交给调用方的快照或字节副本。

## 验收与限制

```sh
pnpm build
node --test tests/runtime-artifact-handoff.test.mjs
```

测试中的固定生产进程在临时loopback HTTP发布合成事件、manifest与字节；第二进程实际核对领取字节的摘要并计算数值之和。损坏/错误报告路径不建立消费进程；无成功报告或清单ID错误时甚至不请求产物字节。仅证明本组合组件和固定测试路径，不是生产调度或真实异构AI协作。

保留原流/帧/观察器/字节预算，既不是全应用内存上限也不是运行超时。宿主须管理权威事件、最新授权、存储引用、截止时间和HTTP边界。报告是声明，摘要匹配是完整性检查；authorization始终false，manifest verification始终unverified。多产物全量准备、真实宿主和持久边界仍未完成。
