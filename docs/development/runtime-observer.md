# 运行事件观察器（ZT12-01-A2）

`@zentwine/client`公开`RuntimeEventObserver`和相关只读类型，消费已验收的wire1.0.0。它是实例内的报告观察器，不是运行宿主、数据库状态机或执行许可。父Issue #46、子Issue #49，精确提交和最终验收见PR #50。

## 使用

```ts
import { RuntimeEventObserver } from "@zentwine/client";

// trustedRequest是调用方已独立鉴权/固定的StartRun，不是页面自行授权。
const observer = new RuntimeEventObserver(trustedRequest);
const result = observer.accept(untrustedEvent);
const view = result.snapshot;
// 先检查synchronization，再把reported_state当作“最后接收的报告”展示。
// result.recovery只建议读取：none / replay / inspect，不执行任何请求。
// 退出登录、撤权、组织/Attempt变化或视图销毁时：
observer.close();
```

构造、accept、getSnapshot、disconnect和close都不请求网络、操作Storage、设置定时器、创建Run、调用工具或派发停止。宿主必须先独立检查身份、组织、当前权限、租约、预算和实际能力，事件不继承StartRun中的授权声明。`authorization`永远false。

每个实例固定一个org/run/attempt和来源；synthetic不能混为adapter_report。构造及accept均复用公开contracts解析器，同步快照/深冻结；普通getter/toJSON不执行。返回固定错误码，不回显被拒绝输入。不是恶意Proxy、被污染JS环境或任意不可信代码的沙箱。传输原始字节与重复JSON键仍由宿主限制。

## 连续前缀、重复与缺口

实例只从sequence=1开始，不接受调用者传入“已确认序号”或任意状态快照。序号用BigInt计算，返回规范十进制字符串；不按occurred_at排序，时间也不作授权/输入有效期的证明。

完全相同event_id、序号和规范化后的完整内容重复返回duplicate，不增加计数、字节、用量或状态；对象属性顺序变化不构成冲突。相同ID而内容变化返回event_conflict，相同已确认序号换ID返回sequence_conflict，进入inspect_required。没有“旧事件直接算成功”的路径。

超前序号只记录最大的gap_through并返回sequence_gap/replay。乱序正文不缓冲、不自动应用，调用者必须显式补读从next_sequence开始的连续事件；补读到已见高水位后才重新contiguous。高水位本身是不可信的缺口提示，不证明遗漏事件存在或其内容。被拒绝的乱序消息不参与已接收事件的重复一致性保证。

coverage恒为accepted-prefix-only；contiguous仅指本实例已经接收的前缀无缺口，不说明已追上服务端、网络在线、报告真实或授权仍有效。重建实例必须从有权限的完整历史重放；当前不支持检查点导入、跨实例去重或跨重启恢复。

## 报告状态与同步状态分开

reported_state可为awaiting_start、running、waiting_input、stop_requested、succeeded、failed、cancelled、unknown。synchronization独立为contiguous、replay_required、inspect_required、closed。界面不可只读取reported_state而忽略后者。

| 当前报告状态 | 可接受的新事件 |
|---|---|
| awaiting_start | started、stop_requested、failed（not_started）、unknown |
| running | waiting_input、stop_requested、succeeded、failed（failed）、unknown、tool/summary/artifact/usage |
| waiting_input | 对应request_id的input_accepted、stop_requested、failed、unknown、summary/artifact/usage |
| stop_requested | cancelled、failed、unknown、usage |
| succeeded / failed / cancelled | 无新事件；完全相同的历史重放仍为duplicate |
| unknown | 只允许识别完全相同的历史重放；新事件要求外部核验 |

request_id在输入、工具及停止请求间不得重复；input_accepted必须匹配当前待答请求，不因审批ID或自然语言回复获得权限。输入到期是否有效必须由真实宿主核验，观察器不把事件时间当可信服务器时钟。停止或unknown报告清除pending_input，但不撤回已经发生的外部动作。

未见run.started时的failed必须为not_started；已见started后不能再声称not_started。开始前发出stop_requested仍可能随后失败且not_started，该有效路径有独立回归。cancelled必须有先前停止请求，stop_receipt仍只是适配器声明，不证明进程或子进程真的终止。

succeeded只保留报告的manifest_id，不证明已取得清单、对象存在、产物内容正确或任务验收通过。summary仅agent_claim，不触发成功。tool.requested不触发工具。产物按同一Attempt的artifact_id固定revision/hash；相同引用重复通知不重复收集，变化拒绝，最多64个。这里只保留引用，不形成可信验证。latest_usage只是最新的一份声明，不相加、不计费，unknown不改为零；同measurement_id换新事件也拒绝。

## 故障、容量与清理

非法消息、绑定不一致、重复冲突、非法状态转换、容量超限会保留最后合法前缀并进入inspect_required；disconnect记录transport_lost但不声称停止。unknown事件也进入inspect_required。后续新事件不能自动解除，重复历史不清除故障。首次fault保留。调用方必须停止把旧投影用于操作，并通过独立授权的inspect/对账处理；本接口不提供把任意报告升级为已核验状态的reset。

默认上限1024个事件、1048576个规范化JSON的UTF-8字节。构造时可传`{max_events,max_bytes}`调低，必须是两个正安全整数且不超过默认上限。选项同步复制，拒绝额外/访问器/隐藏字段。预算只计已接收事件的规范化串，不是JS堆内存上限：固定StartRun、Map/Set、引用及引擎开销另计。调用者持有历史快照的内存不由实例回收。

所有验证在修改事件日志、身份集合、产物与投影前完成。满容量不丢弃旧去重记录；历史完全相同重放仍可识别，新事件明确拒绝并要求核验。此限制意味着它不适合作为长时运行的持久事件存储；后续需受保护的检查点/持久inbox，不能静默从新实例续接尾部。

close清空实例拥有的请求、事件/身份集合及投影，并永久拒绝迟到事件而不再读取其字段。关闭不停止远端进程；调用者已经持有的旧快照无法远程抹除。调用方负责在认证上下文失效时调用close，本组件本身不监听浏览器或认证事件。

## 验证与边界

```sh
pnpm install --frozen-lockfile
pnpm build
node --test tests/runtime-observer.test.mjs
pnpm check
pnpm test:quality
```

72项新增Node测试包含96项八状态/十二事件转换决定、六种三事件投递顺序、公共入口、跨流/来源、未知与停止、精确预算、默认1024容量及无副作用检查；全部使用明确合成消息，不是真实供应商或故障网络验收。新增72项之外的既有协议和产品回归保持。原wire schema、旧FakeRuntime、历史迁移、门禁、依赖锁没有因观察器改变。

完整ZT12-01仍待版本持久化及宿主/真实适配消费。Issue #32/#35、Draft PR #33的维护者阻断不因此解除；没有数据库迁移、运行API/UI、Operation对账、真实模型调用或生产部署。
