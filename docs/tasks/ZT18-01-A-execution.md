# ZT18-01-A 执行记录

状态：实现完成，最终精确CI、制品与合并回读证据以PR #65为准。子Issue #64，父Issue #63。

输入main db83422bb4f2beaf5b147909aec19dc543b92e6c、tree4012bf4647adaaae997fced09382f9707b941897；从PR #62完整工程制品的source.zip取得源码，重建一致Git树后开发。没有改动主线旧产品、旧测试、迁移、校验器、工作流和锁。

新增scripts/lib/local-repository.mjs和scripts/repository-inspect.mjs，读取真实本地Git提交基线和固定普通blob。只抽样index，不报告工作区干净；无网络、仓库写入、过滤器或模型执行。使用方式及信任边界见[指南](../development/local-repository.md)、[ADR-033](../adr/ADR-033-local-git-read-port.md)。

本机Node22.16.0/Git2.47.3：首40项全部通过，补充错误Git字节、promisor缺失、根目录替换、缓冲所有权和stdout故障后45/45通过。提交组树有一处git目录stat读取顺序差异，核对相同树并重新45/45，不沿用不同源码结果。82原文件/1066测试声明保护、包边界和凭据扫描通过。本机结果不是冻结目标完整验收。

初始head04800c1351c51e9d1ddef021c8e5e3525224b930的完整CI36397379293用于取得原冻结Prettier输出；本机npm DNS不可用，临时只读诊断不改变格式门禁。最终按原SHA核对格式、删除诊断，再将代码和文档共同重新完整CI，不能拿初轮或仅本地测试合并。详细实际结果与历史见[报告](../testing/zt18-01-a-report.md)及PR #65。

最终须核对全部必需CI、五份制品与源码一致，expected_head_sha正常合并并回读main后才关闭子64。父63远端/权限关系、父46真实运行联调、40/25及32/35/PR33阻断均不解除。
