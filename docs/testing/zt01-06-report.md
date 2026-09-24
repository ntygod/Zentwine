# ZT01-06 验证报告

## 证据基线

本文件记录已实际完成的验证；最终合并提交及文档更新后的复验，以 [PR #13](https://github.com/ntygod/Zentwine/pull/13) 最新Checks和制品为准。实施者自审，不冒称独立人工审核。

| 运行 | 精确版本 | 结果 |
|---|---|---|
| [首轮36023261644](https://github.com/ntygod/Zentwine/actions/runs/36023261644) | head30f610b84d6c15ae8ba65d5a3fb732eab8177b15；被测e4c5ff6ca7487e4cb7e64842896b9e5613869a65 | 五项必要job及总门禁通过 |
| [恢复与归属复验36024140918](https://github.com/ntygod/Zentwine/actions/runs/36024140918) | headebff791a53a5f3bcbeda11bb95e0c2bf120c7875；被测0d8b5abaa7f6c661ba14554508c19723076ecbba；tree b321b81ebed24278fd558fcfcfb309dd294236d4 | 全部通过，包括新增硬退出恢复 |

## 独立场景与重复执行

| 范围 | 结果与解释 |
|---|---|
| 主工程 | 123/123通过：原94+本轮29工具测试，0 skip |
| 实际Chromium | 原9/9通过，2 Worker；不靠设计图代替页面运行 |
| 开发页面生命周期 | 新3/3：production/未知参数拒绝、占用端口保留、取消后3个端口释放 |
| 本机Compose生命周期 | 新8/8：幂等启动、并行隔离、异常清理、未实现身份继续拒绝、daemon变化拒删、CLI参数、跨进程状态、SIGKILL后精确session恢复 |
| 数据库/迁移 | 原13与8场景通过，并由新drill在独立环境复验；重复运行不计新场景 |
| 持久流程 | 原Temporal/PostgreSQL 8单元+9业务集成通过，再由新drill复验；包含Worker SIGKILL、服务重启、提交后重试和历史回放 |
| 质量机制 | 原50门禁单测、68契约正反例、凭据、测试保护、格式、边界、严格类型、构建、源码不变与文档检查通过 |
| 安装与准备 | clean checkout的fresh诊断、冻结锁安装、空缓存offline失败、热缓存offline成功、CLI固定归档与二进制核验通过 |

本轮新增独立开发环境场景40项，不把重跑原数据库/Temporal/API用例或整个套件的外层test重复计入。

## 真实资源与版本

恢复测试确实终止持有flock的Node进程，观察SIGKILL退出及容器仍在，然后通过新CLI进程仅清理记录的session。它不证明所有断电、磁盘损坏或恶意Docker管理员场景都可自动恢复。

Node24.21.0、pnpm11.10.0；PostgreSQL17.11镜像摘要与Temporal CLI1.9.1归档摘要见机器清单。36024140918的数据库job记录Docker client/server28.0.4、Compose2.38.2、util-linux2.39.3、curl8.5.0（发行版安全补丁）、tar1.35、Python3.12.3；具体系统工具每次CI可能不同，以该次local-toolchain.txt为准。Python传递依赖未声称全哈希冻结。

数据库制品10818142561下载SHA256为5b56217c961dd4f758fbf5d5b6849bd2f91796792fcc46e29341ae384c428d95。已读取实际8场景日志和drill摘要，摘要绑定正确commit/tree、tracked_clean_at_start=true及cleanup=passed。最终制品另在PR记录，全部内含manifest。

## 安全、局限与未运行

无真实模型、客户数据或生产部署。live为skipped_live，不把Fake算live。容器tmpfs只保存合成测试数据；本地凭据单独0600保存，不纳入源码和交付包。首次和后续CI均未删除原断言、添加凭据豁免、提升工作流权限或变更JS依赖锁。

只验证Linux x64；macOS/Windows/ARM64未验收。离线测试限定pnpm缓存与明确的工具/镜像缓存，不宣称全机器断网安装。Git基线+脏状态不是不可变工作树快照，制品SHA不是签名。SIGKILL/断电不保证JavaScript finally，显式session恢复是兜底，不是普遍自动回收。完整业务身份、Studio编辑、真实多模型及E01–E52仍未交付。
