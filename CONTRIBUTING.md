# 参与 Zentwine 开发

## 先选择任务和基线

阅读 [AGENTS.md](AGENTS.md)、[实际进度](docs/tasks/status.md) 和对应 `docs/modules/`。领取有明确依赖与验收的工作包，在独立分支修改；不要以规划总数计算产品进度。目录边界遵循 [架构](docs/plans/02-architecture.md)，重要改变记录 ADR。默认在 Linux 开发；macOS/Windows 原生运行仍需独立验证。

## 新机器设置

先安装 `.node-version` 的 Node 和 package.json 的 pnpm 版本。仓库不静默安装系统软件，不需要提供模型密钥。

```bash
npm install --global pnpm@11.10.0
node scripts/doctor.mjs --profile fresh --json
pnpm install --frozen-lockfile
pnpm check
pnpm doctor
pnpm dev
```

管理端端口 5173、独立 Studio 5174、API 4100，仅绑定本机。数据库/持久工作流不随页面自动启动。`/readyz` 503 是尚未生产就绪的真实状态，不可修改来掩盖缺失能力。

Python 质量工具放入独立虚拟环境：

```bash
python3 -m venv .venv-quality
. .venv-quality/bin/activate
python3 -m pip install -r quality/requirements.txt
pnpm quality:check
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

## 数据库、故障和离线演练

[统一环境指南](docs/development/local-environment.md)说明 `env:up/status/down`、`drill`、`tools:prepare`、诊断分层和故障恢复。环境默认是可销毁的合成数据，不是供业务长期存储的数据库。Docker 有较高本地权限，不能向不可信插件暴露 Docker socket。

新测试按范围加入：纯逻辑 `tests/*.test.mjs`，浏览器 `tests/browser/`，临时数据库 `tests/integration/`，开发生命周期 `tests/development/`。Fake 必须保留 synthetic 标记；不能以模拟结果报告真实供应商通过。测试等待使用明确条件与截止时间，不靠任意长 sleep。

## 提交前

运行 `pnpm check`、`pnpm quality:check` 和改动涉及的浏览器/真实数据库/故障验证。对比基线可显式设置 `QUALITY_BASE_REF=<可信base SHA>`；不能为了通过而删除断言、绕过契约版本、变更豁免或减掉必要 CI job。新行为用新增测试验证；需要修订旧断言时单独记录测试方案决定，不直接弱化保护。

PR 写明工作包、输入版本、变更范围、实际测试及环境、未完成项、回退和残余风险；可参考 [PR 模板](docs/templates/pull-request.md)。合并前核对最新 head/base、总门禁及证据归属。当前连接器没有平台分支保护管理权限，不能把仓库检查当成强制平台保护。

## 安全与许可

不要提交 `.zentwine/`、环境变量文件、真实凭据、客户代码或私人日志。日志按必要字段收集。项目发行许可仍为 UNLICENSED；第三方声明不自动成为产品许可。可复现版本与许可元数据入口见 [工具清单](docs/development/toolchain-and-licenses.md)。不自动购买云服务或部署未验证功能到公网。
