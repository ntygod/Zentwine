# 运行事件字节流读取

ZT12-01-A3在`@zentwine/client`公开`RuntimeEventStreamReader`、`RUNTIME_STREAM_LIMITS`与只读类型，消费调用者已经取得的原生`ReadableStream<Uint8Array>`。没有URL、Key、自动fetch、重连、启动、工具派发或远程停止。完整执行平台仍受ZT03-02-B阻断；这是可独立验收的传输消费者。

## 使用与宿主责任

```ts
import { RuntimeEventStreamReader } from "@zentwine/client";

const receiver = new RuntimeEventStreamReader(fixedStartRun);
// authorizedBody由宿主取得；先检查当前身份、组织、许可、HTTP状态、内容类型及重定向。
const reading = receiver.read(authorizedBody, lifecycleSignal);
// 读取期间可以读取receiver.getSnapshot()，它不触发网络。
const final = await reading;
// 退出、切组织、隐藏或撤权时调用receiver.close()或取消lifecycleSignal。
```

参数`fixedStartRun`通过原wire1.0.0同步解析和冻结。宿主负责可信的原生流与AbortSignal、凭据/CSRF、超时/租约/期限、消息真实性及最新授权。本类不会凭StartRun中的ID证明权限或资源存在；`authorization`恒为false。预取消或已关闭实例不获取来源reader；已经获得但未接管的response/body由宿主自行清理。

每个实例只能消费一次，不能把第二个响应接在旧前缀上。并发/后续第二次read抛固定TypeError，不抢占第一条流。明确补读须由宿主重新鉴权、创建新实例并从序号1提供完整历史，不复用旧实例充当持久游标恢复。

## 字节格式：1.0.0有限NDJSON配置

一条完整wire RuntimeEvent是一帧，以LF或CRLF结束；最后一帧也必须有换行。拒绝空行、仅空白行、BOM、帧内原始CR、非法/不完整UTF-8、注释、多个JSON值与尾随逗号。允许JSON空白但计入原始字节预算。文本字符串中的转义换行不是帧分隔。

内部有界JSON读取器拒绝任何层级的重复解码键，包括`sequence`与`sequen\u0063e`；不先用JSON.parse覆盖重复键。数字只接受十进制安全整数token，拒绝负零、小数和指数，即使IEEE754舍入后看似整数。该有限配置比通用JSON更严格；当前RuntimeEvent数字字段本就全部为整数。字符串token由原生JSON.parse检查转义，字段形状与语义仍交给原wire解析和观察器。

wire1.0.0的摘要是产物引用，没有任意正文槽位。Unicode测试独立核验UTF-8/JSON解码，并验证携带未定义Unicode正文的事件随后被原协议拒绝，不能为了演示中文而扩张已验收协议。

## 顺序、结束与错误

复用原RuntimeEventObserver；字节分片与事件无关。完整帧才进入观察器，固定org/run/attempt与来源，精确重复只计重复数，不重复应用；遇缺口、冲突、非法状态或unknown即停止读取，要求inspect，保留此前合法前缀。与原观察器的可继续补读模式不同，本传输封装不在出错响应上继续接收。

`status`为idle/reading/ended/inspect_required/closed；`observation.reported_state`独立保留最后合法报告。仅在有合法终态、所有帧完整且EOF时标ended；ended只表示这个响应按配置结束，不证明模型成功、任务验收、产物存在、取消确实停止了进程，亦不证明服务端没有更多历史。完整帧后的非终态EOF是unexpected_eof；未换行尾部是truncated_frame；源异常是transport_lost。即使此前报告succeeded，坏尾部仍进入inspect_required。

错误仅固定fault和event_code，不回显原始坏帧、源异常或Abort原因。`consumed_bytes`只计实际检查的字节，不是网络总接收量；流预算耗尽时不再计超预算字节。`framed_events`为通过JSON分帧并交给观察器的帧数（含协议拒绝帧和重复）；坏JSON不计入。`duplicate_events`仅完全相同重放。多帧块非原子批次：后帧坏掉不撤销先前合法前缀。

## 有界保留与生命周期

默认每帧262144原始字节（不含LF、包含可选CR），每条流4194304原始字节，2048个JSON帧，64个空字节块；四项可降低但不能提高。所有字节包括空白和重复都收费，空块另有限额。原观察器的1024个不同事件/1MiB规范化JSON/64产物限制同时有效。JSON深度16、8192节点在构造解析结果前检查。预算不是JS总堆、源缓冲、传输层总量或总运行时间上限。

读取过程中仅保留当前帧与原观察器的有限前缀。每次等待的中断Promise在本次read结束后释放，避免逐字节输入在一个永不完成的全局Promise上积累反应。未结束且不返回数据的来源由宿主超时/Abort处理，本类没有定时器。

close同步清空本地投影、计数和缓冲，取消本地reader并中断等待；不等待底层cancel Promise完成。取消失败不泄漏未处理拒绝，最终释放reader锁并移除Abort监听。原生源仍可运行自己的清理代码；不承诺远端停止、收回调用者旧副本或对JavaScript内存进行密码学擦除。已经close后迟到读取不会重新填充状态。原生来源/平台内建函数属可信宿主，不是恶意Proxy或被篡改运行时的沙箱。

## 验证

新增80项测试：76项原生Web流/内部JSON边界，4项实际本机HTTP；包含所有两块切分、单字节/转义/中文与emoji、坏UTF-8/重复键、精确容量、断流/未知/取消不响应、监听及锁释放。所有HTTP请求只访问测试临时127.0.0.1端口；一字节服务端write不等于网络按相同分片交付，强制分片由原生Web流测试另外保证。源码和全部产品回归的最终精确CI/制品/合并记录见关联PR；合成消息不是供应商验收。
