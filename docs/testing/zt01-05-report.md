# ZT01-05 验证报告

输入基线 main@9b7357d69a375263b33290e157293369ff5ecac5。已有实现验证通过；最终复验提交、合并树及制品以 [PR #11](https://github.com/ntygod/Zentwine/pull/11) 为准。此报告引用固定已完成运行，避免把尚未生成的当前文档提交SHA写成已测试。

## 首轮完整运行

[统一CI 36005933620](https://github.com/ntygod/Zentwine/actions/runs/36005933620)，功能head abe89a4d66bed0e4499a796b12f37799a3d72a9e，实际测试提交392de19b1ca53654badd0041e1521ce5b157e004，源码树a96441384206371bf494d7ce5d0c511dc81133a2。

| 套件 | 结果与范围 |
|---|---|
| 工程 | Node24.21.0/pnpm11.10.0冻结安装、格式、边界、类型、构建通过；94个原核心/API/Fixture通过 |
| 浏览器 | 9个真实Chromium场景通过，2Worker；退出释放3个开发端口 |
| 既有数据库 | 13个真实PG场景通过，Compose重复相同13场景并清理，不重复计数 |
| 迁移 | 8项通过：应用/幂等、历史改写拒绝、DDL失败回滚、验证失败回滚、撤销再应用、撤销失败保护、未支持语句拒绝、实际清单演练 |
| 契约 | 6个正例、62个反例通过；4个规划协议与2个已实现API schema区分 |
| 门禁单测 | Node11项、Python39项通过，缺失/失败/取消依赖、删除/修改/跳过测试、过宽权限、凭据、产物损坏等负例 |
| 耐久回归 | 既有真实Temporal/PostgreSQL故障与回放实验通过，原断言保留 |
| 文档及依赖 | 文档/Schema通过；当次pnpm审计无漏洞报告，非永久安全声明 |
| 总门禁 | 五个必需任务成功，quality-gate通过 |

AST扫描的126个静态测试声明不是126个独立业务场景，测试与嵌套子测试不混合计数。

## 制品核验

下载policy、数据库及工程制品并验证每个manifest和文件摘要，实际测试提交一致。工程source.zip的200个受追踪文件与上传树逐字节相同；JavaScript锁文件未变。制品摘要清单是完整性索引，不是独立签名证书。

| 首轮制品 | ID | ZIP SHA-256 |
|---|---|---|
| policy | 10809963788 | 00d0df881d13338a892bc372ff03c66f9c1de37a8b3e62c75df8ad02c7263db1 |
| 数据库 | 10810184320 | 41c57276c06f8113719d04ec4219778e81df29c72b0b4d41dc1fa313935f13ab |
| 工程 | 10810223477 | 8972677c8c30b7b5bc47a9d5902ae163805f04eaccbbfaab81f2c67b0672922f |

## 未执行及边界

- live报告为 skipped_live / credentials_not_configured / executed:false；Fake未用作live证据。
- 当前业务迁移数0，报告no_business_migrations；8项引擎与清单演练不代表生产数据迁移、备份或性能验证。
- 原工具的test GUC/网络限制不是生产身份或OS沙箱。新增SQL词法检查是保守限制，不是对任意SQL的安全证明。
- CI只读，不注入生产Secret或自动部署；连接器读取branch protection返回403，本次未配置平台强制required checks。
- 必要测试保护和流程检查不能抵抗有管理权限者修改检查器本身；此工作为实施者自审而非独立审计。

## 复现

使用 [质量门禁指南](../development/quality-gates.md)。`pnpm check` 后运行 `pnpm quality:check`；专用数据库准备好后运行 `pnpm test:integration` 和 `pnpm test:migrations`；浏览器安装后 `pnpm test:e2e`。缺失数据库配置返回失败，不静默跳过。新提交必须重新通过全部CI。
