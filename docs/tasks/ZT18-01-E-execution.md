# ZT18-01-E 执行记录

日期：2026-09-29｜Issue #73，父 #63｜基线 main `cb21b538222045aed656d88a6b2ed9fa85cb44d9`（PR #72）。

## 本次范围

独立Studio的文件级意见、原报告精确字节SHA-256绑定、显式准备/下载/重新导入、错误与过期读取隔离、对象URL回收。共享client处理格式和不可变意见，ui处理草稿及下载，app只添加样式。不提供批准、远端PR评论或持久Review，不改变原Git端口/CLI和报告格式。

按harness加载目标祖先指引；[ADR-037](../adr/ADR-037-local-review-notes.md)、[使用指南](../development/local-review-notes.md)、[验证报告](../testing/zt18-01-e-report.md) 与索引同步。

## 验证与提交

本地为Linux Node22.16.0/TypeScript5.8.3/Git2.47.3/Python3.13.5，仅辅助环境。新增44意见测试与原49导入、154 Git套件合跑247/247通过；真实Git→CLI和独立Node摘要验证往返与错配。本地无冻结workspace/浏览器依赖，UI及全量固定环境验证以关联PR的最终完整CI与制品为准，不将定义当执行通过。

保持旧测试体、历史迁移、锁文件及必需工作流不变。最终精确head/base/candidate/tree与全部六任务、五组制品核验通过后才合并并回读main；结果追加到关联PR，不沿用旧head绿色。

## 保留边界

原报告和自填署名仍未认证；意见可伪造，摘要不是授权。#32/#35/Draft PR33、#25/#40/#46/#63原关闭条件不变，不重试被拦截迁移修改。无真实模型/IdP、生产部署、付费或历史分支删除。回退新增client/UI和接入即可；已下载用户文件不自动删除。
