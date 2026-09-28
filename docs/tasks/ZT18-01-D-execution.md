# ZT18-01-D 执行记录

日期：2026-09-28｜Issue #71，父 #63｜基线 main `b7e0449ee945fa9faf243368a1650d8cd5e48347`。

## 限定交付

为原C比较报告增加独立Studio显式导入、文件清单/筛选/分页、单文件hunk纯文本阅读、未渲染/缺正文/空状态、清除和读取代次隔离。共享client解析来源未认证的报告，ui组件负责交互，app组装，不改原Git端口/CLI/运行能力。

读写目录已按harness路由加载；新增 [ADR-036](../adr/ADR-036-studio-comparison-review.md)、[使用说明](../development/studio-code-review.md)、[验证记录](../testing/zt18-01-d-report.md) 与相关索引。

## 实际验证与合并条件

本地Linux Node22.16.0 / TypeScript5.8.3 / Git2.47.3仅补充验证。49项导入测试（真实Git/CLI及拒绝样本）与原154项Git套件合跑203/203通过，固定Prettier3.6.2与包边界通过。首次编译因ES2022 lib不含String.isWellFormed声明失败，改用Unicode孤立代理项检查后重编译/复验通过，没有升级编译配置。CLI的exit_code在真实端到端输入前检查时补充为可选且只接受0，端口报告仍支持。

新增浏览器定义由关联PR的固定环境完整CI验证；本地无冻结workspace及浏览器依赖，不能把测试定义当通过。最终状态以该PR的精确head/base/candidate/tree、六任务与五组制品核验及main回读为准。旧测试体、迁移、锁文件、必需workflow不变；解析器抽出有界内部函数但旧runtime预算不变。

## 剩余

无原仓库认证、远端绑定、持久Review、编辑器、执行/合并权限。#32/#35/Draft PR33、#25/#40/#46/#63保留；不重试原被拦截迁移写入。不删除历史远端分支，不调用模型、部署或付费。回退新增client/UI及app入口，不写用户仓库。
