# ZT12-01-A2 验收记录

范围：有界、实例内、只读RuntimeEventObserver。基线main `bdfa8449ea039b45fa407055c6cbf25911cd5d8e`；子Issue #49、父Issue #46、PR #50。最终精确head、完整CI及归档核验/合并事实记录在PR #50，不用旧PR #48的通过结果代替本增量。

## 本地复现与红绿

本地Node22.16.0/TypeScript5.8.3编译contracts/client并从client公共入口测试。最初新增63项，62通过/1失败：prestart stop followed by not_started failure被invalid_transition拒绝。原因是只看当前状态是否awaiting_start，而开始前请求停止会变为stop_requested；修复通过observed_model是否已经由run.started设置判定开始前后，不修改测试预期。随后63/63及旧147协议测试通过；补充8状态矩阵和1排列测试后新增72/72。

新增72测试内部包括96个状态/事件决定、三事件全部六种投递排列。这些不是额外计入顶层测试总数的独立套件。默认1024条容量实测保留首事件去重，字节预算精确等额可接受、差1字节拒绝；无网络/Storage/定时器入口触碰。所有样本是合成，测试实际执行本消费者，而不模拟其成功返回。

本地包边界通过，原73受保护文件/844声明保持。源码从PR48最终工程归档提取，验证归档SHA与其精确472文件Git tree后作为本地独立基线；本地git提交只是验证索引，不冒充远端main commit。最终必须以GitHub冻结工具链为准。

## 初始诊断与目标CI

初始head `206d39a45be58ea02fd7b7faf54c297a923de732`，tree `03f1513c14a21165490af5648b3b0afdce06d380`，run `36325300173`。本机npm DNS不可用，工具下载也未取得Prettier；临时Python诊断只调用CI原已冻结Prettier3.6.2产生建议，并核对源码没有重写，不改format:check或CI工作流。初始工程任务108636901941实际在格式检查失败，下游主工程/默认浏览器跳过，未合并。质量制品10933713565的ZIP SHA-256为7a61dcb4002aef0034393cebc4da85859fd62e11073454890f4416175a79e384，13个manifest条目逐项核验；其被测候选b99cd3309d9df677c58aca1bb25eeca1d313a433、tree与初始head源码相同。未将未下载的初始其他制品称为已核验。

后续提交已核对建议中的原始SHA后应用格式、删除临时诊断文件，附上本报告及使用/ADR/任务文档，须从原门禁完整复验。代码树6b6731e2aa4467e4ff22cb4667ff290dda8c5346与本地审阅匹配，格式后重新编译并通过新72/72及新旧协议合计219/219。不将临时诊断算作正式产品新增测试；所有正式72测试及旧测试保留。初始和最终实际结果、失败及修复追加到PR50，不删除历史。

## 验收索引

完整CI须包含policy、engineering、database、durability、documentation、quality-gate，精确绑定candidate/tree与head/base。新增72名称必须与实际通过日志逐项匹配；主工程目标为原639+72，实际数量以日志为准。既有25默认浏览器、43组织PG浏览器及旧数据库/审批/组织/权限/迁移/环境/Temporal也必须实际回归。没有新增UI、数据库或浏览器场景，不把旧回归当新增交付。

五份归档须逐项核对SHA、manifest文件长度/摘要及job_status、candidate/tree/run/attempt；三份完整源码须核对路径/Git blob/执行位。正常/严格权限矩阵和缺配置入口保持原含义：文件/预览/导出未实现，严格仍非零；live必须单列未执行，不混入真实模型通过。重复演练与cleanup通过不增加独立覆盖数。

## 保留边界

观察器不是权限证明、宿主、服务端Run状态权威、持久inbox或真实适配器。成功/停止是报告，摘要是agent_claim，产物只有精确引用；用量不累计成账单。contiguous不证明已追上服务器，unknown/断连/矛盾不能自动恢复，close不撤回已返回的副本或停止进程。

无业务库迁移、部署或真实模型/IdP/付费动作；原迁移校验器、工作流、依赖锁及旧测试不改。父Issue46/40、25/32/35和DraftPR33保持。此次实施与自审不称独立第三方认证。
