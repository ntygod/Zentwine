# 按影响选择验证

命令在仓库根目录运行，版本取 `.node-version`、`package.json` 与冻结锁；本地替代版本的结果只能标为补充。先 `pnpm install --frozen-lockfile`，Python 工具安装见 [贡献指南](../../CONTRIBUTING.md)。不要照抄含占位符的命令为已执行证据。

## 所有改动的基础检查

```bash
pnpm check
pnpm format:check
pnpm quality:check
pnpm harness:check
pnpm docs:check
```

`check` 保持 lint → build → typecheck → test；`quality:check` 保留历史测试、凭据、契约、迁移、工作流、依赖与门禁正反例。文档改动也走原完整 CI，不能只凭文档绿灯合并。完整 CI 通过不等于真实模型或生产发布。

## 影响路由

| 改动 | 额外验证 | 前提/边界 |
|---|---|---|
| AGENTS、导航、harness、维护脚本 | `pnpm test:harness`；`python3 scripts/validate_plans.py --validate-schemas` | harness 使用 Python 标准库；schema 使用固定验证依赖 |
| API/共享契约 | `pnpm contract-check`；受影响 API 测试 | build 后验证真实公开入口；旧发布快照不覆盖 |
| Workbench/Studio/UI | `pnpm test:e2e` | 先安装 Chromium；当前真实本机 API，不调用模型 |
| 身份 | `pnpm test:identity` | 专用临时 PG；[身份指南](../development/identity-sessions.md) |
| 策略/Agent | `pnpm test:policy`、`pnpm test:agents`；对应 `pnpm test:policy-integration`、`pnpm test:agents-integration` | 纯规则不能代替 PG/HTTP/WS |
| 审批 | `pnpm test:approvals`、`pnpm test:approvals-integration` | 独立角色、版本绑定、撤权和过期 |
| 组织/业务 UI | `pnpm test:organizations-integration`、`pnpm test:organizations-ui` | 真实 PG 与浏览器，非默认壳测试 |
| 审计/应急 | `pnpm test:audit-integration`、`pnpm test:audit-ui`；`pnpm test:emergency-integration`、`pnpm test:emergency-ui` | [开发指南索引](../development/README.md) 对应环境 |
| 数据库/迁移 | `pnpm migration-check`、`pnpm test:migrations`、`pnpm test:tenant-integration` 及业务套件 | 临时合成库、权限隔离；禁止绕过静态检查提前安装 |
| 测试设施 | `pnpm test:fixtures`、`pnpm test:integration` | [测试指南](../development/testkit.md)；缺配置失败 |
| Runtime wire/观察/交接 | `pnpm check`；涉及 UI 再跑浏览器 | 保留截断/重复/取消/预算等原测试；真实模型单独验收 |
| 本机 Git 端口 | `node --test tests/local-repository.test.mjs tests/local-worktree.test.mjs` | 真实临时 Git/子进程；不是远端组织权限验收 |
| 开发环境/持久实验 | `pnpm drill --suite database` 或 `pnpm drill --suite durability` | 显式准备合成设施；[环境指南](../development/local-environment.md) |

数据库精确配置/启动清理以对应指南为准，不在此复制另一套凭据和环境名。`pnpm test:live` 单独报告真实模型状态，Fake 不算 live。权限矩阵严格验收仍保留缺通道阻断，不能降低模式消除失败。

## 每次交接应有的证据

记录 base/head/tree、工具版本、实际命令与退出码、通过/失败/取消/跳过/未执行、报告及 CI run/attempt 对应关系；失败后明确修复并重新测试哪个提交。摘要核对不能代替测试，旧提交制品不能迁移到新 head。

当环境不可用：保留能完成的静态/纯测试结果，明确缺失的真实套件，不合并需要该证据的变更。审查最终 diff，不修改旧测试/迁移/门禁来得到绿灯。完整 CI 后通过 expected head 合并，再核对 main 的实际树。
