# ZT12-01-A4 执行记录

状态：限定实现已提交；精确head验收与实际合并状态以PR #54为准。Issue #53，父Issue #46。

基线main `286f3fba183124e6a66b744e7b53ada49bcb6e76`，tree `5beb15d1c9882c13915cd2c25eb0491100c89d6a`。已从PR52最终工程归档恢复源码并重建同一Git树；实时main回读一致，无其他新功能PR。

## 实现

公开RuntimeInputArtifactReader：绑定消费者输入及生产manifest，实际原始字节有界读取，EOF/长度/SHA-256检查后一次性交接同一缓冲。close/Abort和固定拒绝路径不交出部分内容，matched后取消仍有效，读取/摘要等待可中断。仅字节完整性，不升级verification或授权。

见[ADR-028](../adr/ADR-028-runtime-input-artifact.md)、[指南](../development/runtime-input-artifact.md)和[报告](../testing/zt12-01-a4-report.md)。根据总计划固定Fixture并行规则独立实现，不绕过原ZT03-02或迁移审查。

## 本地验证

Node22.16.0/TypeScript5.8.3实际编译contracts/client；76新增测试通过，含5真实loopback HTTP。全部375运行相关测试通过，无失败/取消/skip/todo。包依赖边界通过。这不是冻结Node24目标或真实模型/持久数据库验收。

## 初始失败与格式收尾

初始head `d0915b57dd58cc070e4556eb5af58272d8734679`，CI `36334226911`（run86）的工程格式检查失败，其后主工程/默认浏览器步骤未执行，未合并。只读诊断调用既有固定Prettier3.6.2输出建议并核对原文件SHA；最终源码应用建议并删除临时诊断，全部76正式测试保留。格式后375运行相关回归再次通过，七份文档与代码一起进入最终完整CI，不沿用初始检查。

## 关闭条件

最终代码和文档必须通过精确head全CI、五份制品/源码核验；以expected_head_sha合并并回读实际main后，仅关闭子53。父46持久联调与真实宿主、40内容协作、25完整通道、32/35与DraftPR33保持。无旧测试/协议/迁移/门禁/锁变更或真实模型/生产/付费动作。
