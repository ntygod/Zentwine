# ADR-009｜可核验的统一工程质量门禁

状态：Accepted（限本工作包的工程决策）。日期：2026-09-24。任务：ZT01-05，Issue #10。决定者：依据项目负责人已有授权的 AI 实施者；这是实施者自审，不是独立审计。

## 决定

采用一个全 PR / main 的 `Zentwine quality` 入口，调用既有工程、数据库、耐久流程和文档工作流。保留原测试命令；它们变为 workflow_call，不再按路径产生缺失的必要检查。最终 `quality-gate` 总是汇总全部必需节点，失败、取消、跳过、缺失均不能判为成功。

增加只读检查工具：测试语法及断言保护、凭据扫描、契约版本/正反例、迁移清单/历史与真实临时库演练、精确依赖和构建文件摘要。PR 不接收真实模型凭据，不使用 pull_request_target，不拥有写仓库权限。所有外部 Action 继续固定完整 commit SHA。

## 检查与授权分开

CI 自测不能防止拥有仓库管理权的人修改 CI 本身。平台分支保护需要 GitHub 服务端的 required status checks / rulesets。当前连接器读取 main protection 返回 403，因此本次不声称已设置或已确认平台强制保护。受托实施者合并前必须核对精确 head、base 和完整 quality-gate。推荐平台 required check 为 `quality-gate`。

测试保护读取明确 base commit 的源文本并解析 AST，不执行基线代码。删除既有测试或修改其 callback 需要显式测试方案评审，普通 PR 不通过；新增独立测试和格式变更允许。此机制不等于证明任意 helper 或实现代码不会作弊，也不是形式化验证。基准更新应是经记录和审阅的政策变更，不能自动从变更后的代码重新生成“旧基线”。

## 有意限制

- 迁移演练仅支持显式清单中事务性、可逆 up/down/verify SQL，复杂迁移、非事务索引和生产备份恢复不由本工具批准。当前业务迁移为空；仍运行合成 SQL 的应用、失败回滚、撤销和重试实验。
- 四个规划 schema 与已实现 bootstrap/error schema 分开。既有版本路径的验证语义不可覆盖；新协议须新版本并保留兼容测试，不把 schema 样例当成授权证明。
- 凭据检测覆盖受追踪文本中的高置信模式，默认不输出匹配值；18 项原有合成测试/本地 DSN 用精确路径、规则和行摘要豁免。普通 PR 不能自行增加有效豁免。不是全部 Git 历史扫描，也不能识别任何编码秘密。
- 制品清单证明文件完整性与被测提交关系，不提供独立签名、身份认证或生产验收。
- 无 Key 输出 skipped_live；存在 Key 但适配器未实现则 blocked_live 并失败，不把 Fake 充作真实模型结果。

## 依赖及回退

不升级 JavaScript 依赖或改变锁文件。CI 工具使用固定 jsonschema 4.26.0 和 PyYAML 6.0.3，解析 YAML 用 BaseLoader，不构造任意 Python 对象；记录实际 Python 依赖清单。Python 传递依赖不是哈希冻结供应链，后续工具链封装继续收敛。

回退该 PR 恢复四个独立 CI 入口及原工程，不涉及生产数据库变更。回退不得丢弃当次验证记录。

## 官方依据

- [复用工作流](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)：workflow_call、同提交本地引用与权限约束。
- [GitHub Actions 安全](https://docs.github.com/en/actions/reference/security/secure-use)：固定 Action SHA、最小权限、隔离不可信输入。
- [工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)：needs、always 和上下文。
- [PostgreSQL 17 ROLLBACK](https://www.postgresql.org/docs/17/sql-rollback.html)：事务撤销语义；不扩大为任意外部动作撤销。
- [PyYAML 6.0.3](https://pypi.org/project/PyYAML/6.0.3/) 与 [jsonschema 4.26.0](https://pypi.org/project/jsonschema/4.26.0/)：工具版本来源。
