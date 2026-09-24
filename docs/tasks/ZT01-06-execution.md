# ZT01-06 执行记录

输入：main@b8bff3d7fc58e4a1733f5881bd8e59e8eac5aeb6；源码树8b03547b7d2fa34b8f651a9c08dac634685c115d。分支 `feat/ZT01-06-development-environment`，关联 [Issue #12](https://github.com/ntygod/Zentwine/issues/12)、[PR #13](https://github.com/ntygod/Zentwine/pull/13)。

状态：Done（限定实现与实测验收；本记录更新后的精确CI和最终合并以PR为准）。实施与自审：本次AI开发会话，依据负责人既有授权推进，不冒称独立审查。

## 交付

统一env:up/status/down、分层doctor、固定工具准备、独立session数据库和耐久故障drill、进程组清理、贡献指南、版本许可资料。包含42个新增开发环境场景：31工具、3应用生命周期、8真实Compose/恢复。原页面/业务范围不扩展，原测试断言不改写，JS依赖和锁不变。

收尾发现并修复启动失去应答后恢复记录过早删除的问题：outcome_unknown保留精确session，普通清理仅删除可见自有资源，不把资源查询为空视为远端操作结束；操作者确认已停止后使用--confirm-stopped最终收尾。失败/未知清理不能产生成功drill报告。

## 实际验证

[完整修复复验CI 36026514639](https://github.com/ntygod/Zentwine/actions/runs/36026514639) 全部通过。功能head cd544488125f005528c5529c43d5b074013fa62e；实际PR候选被测commit 5bf965c7f88c990601ad2272134f38b9e14aea5c；tree 1f907651ab499c502aa2ebc23f349e8c512503a1。

125个主工程、9个浏览器、3个启动/取消、8个环境生命周期场景通过；原13个PG、8个迁移、Temporal 8单元+9业务集成、50门禁单测与68契约正反例保留。新drill重跑原用例不重复累计。数据库、持久流程、工程、策略和文档五项及总门禁均成功。

历史运行与工具版本见 [验证报告](../testing/zt01-06-report.md)。本记录更新后仍需新精确提交CI及制品核对，不能沿用旧成功绕过检查。最终下载制品、源码匹配和合并commit在PR记录。

## 范围与回退

仅Linux x64本机合成资源。无付费模型、客户数据、生产部署或新增云资源。Docker/flock/标签不是管理员安全边界；SIGKILL/断电仍需按session恢复。产品E01–E52与业务身份/Studio编辑/真实多模型未因此完成。平台强制分支保护未由本轮配置。

ZT01六个工作包具备限定实现验收，这不是W0全部跨模块完成。下一项ZT02-01：组织、身份、会话、成员关系与API租户上下文。回退前用本版本清理本机session，随后回退本PR；无生产迁移。
