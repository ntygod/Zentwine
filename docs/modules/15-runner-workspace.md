# ZT15｜Runner、执行环境与工作区控制

状态：Planned。负责人职责：平台、安全、执行、质量。依赖模块：ZT02、ZT03、ZT12。对应蓝图：09.3、17.6、18.2。

## 目标

让本地、团队、托管和私有环境中的 Agent 可控执行；把代码工作区生命周期与浏览器窗口生命周期分离。强制执行边界，而不是仅在提示词写“不要越界”。

## 对象与协议

RunnerRegistration、EnvironmentProfile、Workspace(repository_set,base_commits,volume,visibility)、Lease(holder,epoch,expiry)、ProcessTree、Checkpoint(manifest,patch,untracked,environment)、PortReservation、CredentialLease。

Runner 主动连接控制面，使用短期身份与心跳；指令带 operation_id、policy、lease epoch 和到期。独立 spool 保存未确认事件，重连后去重上传。上下文和 code snapshot 绑定 digest。

## 开发工作包

| ID | 前置 | 开发内容与交付 | 验收标准 |
|---|---|---|---|
| ZT15-01 | ZT12-01、ZT02-03 | 实现 Runner 注册/认证/心跳/升级状态及任务领取协议 | 伪 Runner、跨租户领取、旧认证重放被拒绝；无模型也能运行测试进程 |
| ZT15-02 | ZT15-01 | 实现环境创建、代码基线、可写卷、资源/网络策略与销毁 | 仓库不能访问宿主 secret/socket；路径/符号链接/私网出口受控；失败清理有记录 |
| ZT15-03 | ZT15-02、ZT03-04 | 实现独占写租约、fencing epoch、续租和本地失联停止守护 | 数据库失联后旧进程停止写入；未确认停止则不授予新写入者 |
| ZT15-04 | ZT15-03 | 实现检查点、人/Agent 交接、文件/diff/终端/LSP/预览受控服务 | 未提交和未跟踪文件可恢复；只读观察者不能通过终端或预览写入 |
| ZT15-05 | ZT15-04 | 实现停止进程树、重启对账、资源预约、端口/数据库隔离和垃圾回收 | cancel 不留越权后台进程；未知状态隔离；两个测试不抢同库/端口 |
| ZT15-06 | ZT15-05 | 完成本地/团队/云环境兼容测试、故障演练和 Runner 运维指南 | 断网/休眠/磁盘满/强杀/过期租约/重复领取均有安全结果；收集真实性能证据 |

## 特殊设计约束

Git worktree 不等于沙箱；针对不可信多租户代码采用经威胁模型验证的强隔离。[S06] 控制平面不能挂载可被 Agent 改写的策略/验证配置。工作区交接不仅换数据库 holder，还需要撤销旧工具许可、停止进程和隔离文件访问。

本地机器完全受用户控制时，平台不能保证用户绕过客户端不会改文件；展示管理边界，并通过提交/基线校验发现变化。对合并和发布等平台动作仍实行统一控制。

## 完成条件

Lease/Checkpoint 协议及两个真实 Runner 环境测试；安全反例、清理/恢复手册、日志脱敏、资源计量和停止证据齐备。关闭浏览器不影响远端生命周期，机器休眠则准确报告不可达。
