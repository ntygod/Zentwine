# 工程质量门禁使用指南

任务 ZT01-05；范围是工程验证，不是产品完整验收或生产发布。

## 本地运行

Node/pnpm 沿用根 README。Python 3.12 为 CI 系统版本；创建独立虚拟环境，避免修改全局 Python：

```bash
python3 -m venv .venv-quality
. .venv-quality/bin/activate
python3 -m pip install -r quality/requirements.txt
pnpm install --frozen-lockfile
pnpm check
pnpm quality:check
pnpm test:live
```

`quality:check` 需要此前 build 生成的 contracts 和 API。比较当前修改时将 QUALITY_BASE_REF 设为可信 base commit SHA；未提供时测试完整性以本地 HEAD 为基线，契约/迁移只有本地结构校验，**不代表完成跨版本检查**。CI 会强制解析 PR base / push before 的精确 SHA，不使用可漂移的分支名。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm test:integrity` | 比较 Node/Playwright 既有测试调用 AST；保护 Python test 方法；拒绝 skip/only/todo 等 |
| `pnpm secret-check` | 扫描 Git 受追踪工作树，不打印命中内容 |
| `pnpm contract-check` | 从真实 API inject 响应导出已实现 schema，校验快照、4个规划协议及正反例 |
| `pnpm migration-check` | 检查有序、只追加的迁移清单与文件摘要 |
| `pnpm test:migrations` | 在明确授权的临时 PostgreSQL 演练，缺配置即失败 |
| `pnpm test:quality` | 运行检查器本身的正常/拒绝场景 |
| `pnpm test:live` | 报告真实模型未执行原因，绝不自动发起付费请求 |

现有 `pnpm test:integration` 和浏览器命令保持不变。数据库环境参见 [隔离测试指南](testkit.md)。迁移测试仅使用 ZENTWINE_TEST_DATABASE_URL、显式 ACK 和服务端测试标记；不会使用生产 DATABASE_URL。

## 如何新增测试和变更测试

新增独立测试可直接提交；既有 callback 改写/删除会触发门禁。重命名、修改旧期望、改变 skip 等都属于测试方案变更，需要保留理由和基线，不应删掉保护脚本或令失败可选。AST 相等不是语义证明；helper、测试发现配置、CI 本身仍需评审。

## 如何新增数据库迁移

清单为 `packages/db/migrations/manifest.json`，条目形如：

```json
{
  "id": "0001-example",
  "transactional": true,
  "up": {"path": "packages/db/migrations/0001-example.up.sql", "sha256": "<64位文件摘要>"},
  "down": {"path": "packages/db/migrations/0001-example.down.sql", "sha256": "<64位文件摘要>"},
  "verify": {"path": "packages/db/migrations/0001-example.verify.sql", "sha256": "<64位文件摘要>"}
}
```

verify SQL 必须返回一行 `verified = true`。清单中已有项及其摘要不改写；错误用下一迁移修正。工具拒绝自行 COMMIT、跨数据库/角色操作、COPY、DO/CALL、CONCURRENTLY 等未支持操作。其词法限制保守，注释/字符串中匹配也可能被拒；不是通用 SQL 安全证明。未来复杂迁移应扩展明确能力与测试，不以删规则绕过。

演练包含新库完整应用、base版本升级、重复应用、逆序撤销和再应用。当前没有业务迁移，报告 `no_business_migrations`，合成引擎测试与业务迁移数量分开；不将0项业务迁移说成生产迁移已验证。

## CI 与总门禁

`quality.yml` 调用四个原有工作流，不减原断言。policy 先检查，再并行运行工程、数据库、耐久流程和文档。quality-gate 用 always 汇总；任何必要 job 非 success 都失败。真实模型状态只表示未执行，不属于工程通过的模型证据。

集成只能读仓库；没有生产 Secret 注入，禁止继承全部 secrets。CI 不合并 PR，不部署。GitHub 平台端保护本次未改动：连接器管理 API 返回403，不能据此判断当前 protection 是开启还是关闭。受托合并必须人工式核验最新 head/base 和所有必要结果；仓库管理员可在平台配置 required `quality-gate`。

## 制品核验

每个工作流 artifact 内含 artifact-manifest.json，记录被测提交、源码树、锁文件摘要、job状态及文件清单。下载解压到一个独立目录后：

```bash
python3 scripts/quality/gate.py verify-manifest --directory /path/to/artifact --expected-commit <被测提交完整SHA>
```

文件缺失、增加、损坏、重名或路径穿越会失败。不要把此文件摘要清单当成签名证书；来源可信度仍依赖 GitHub 运行身份及仓库权限。
