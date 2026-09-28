# 渐进式披露 Harness

本体系服务团队在不同 Agent/工具之间可靠接手同一仓库。它不是新的执行宿主，也不是授权或沙箱：用短规则、目录路由、按需证据与可执行检查组成工作闭环。

## 三层上下文

| 层 | 何时读取 | 内容 |
|---|---|---|
| 根 AGENTS | 每个任务开始 | 目标、全局不变量、最小工作闭环 |
| 目标目录祖先 AGENTS | 编辑/读取新区域前 | 该层边界、入口与验证要求；多目标取并集 |
| 指南/ADR/任务/证据 | 规则触发或问题需要时 | 具体命令、决定、当前状态与精确验证，不自动递归加载 |

根和所有目录指南见 [manifest](manifest.json)。每份最多 80 行/4096 UTF-8 字节，单条继承链最多 12288 字节。这是本仓库预算，不是模型 token 限额；多目标并集会另报总字节，任务仍应合理切分。

## 真实的使用闭环

```bash
python3 scripts/harness.py context packages/db/src/index.ts tests/integration
python3 scripts/harness.py check
python3 -m unittest discover -s tests/quality -p 'test_harness*.py' -v
```

等价 pnpm 入口为 `harness:context`、`harness:check`、`test:harness`。路径均从仓库根目录计算；可路由尚未创建的文件。context 只返回路径、逐目标继承顺序与字节预算，不自动执行文档中的命令。必须实际阅读输出的文件；子目录指南不能跳过祖先指南。

工作顺序：定位最新状态与工作树 → 路由目标 → 阅读适用规则和必要证据 → 明确小工作包 → 修改与新增测试 → [按影响验证](verification.md) → 自查 diff/未完成范围 → 精确 head 完整 CI → 合并并回读。新目标、新事实或失败出现时重新定位，不一路沿用旧上下文。

多人/多 Agent 并行时各用独立分支/工作树，约定写入文件与接口；同一文件冲突由一名负责者整合。交接记录目标、base/head、变更文件、验证命令与结果、阻断和下一动作，不交接私有思维链或凭据。模板见 [PR 模板](../templates/pull-request.md)。

## 不假设所有基座加载方式相同

Codex 按启动工作目录构建根到当前目录的指引链；链接不会自动展开。Claude Code 的加载还受版本与 instructions 模式、CLAUDE.md 是否存在影响。此仓库统一维护 AGENTS.md，不添加会遮蔽链的重复 CLAUDE.md，也不修改个人配置。未自动加载的基座由调用方显式提供 context 输出中的同一组文件。

官方语义参考：[Codex AGENTS](https://developers.openai.com/codex/guides/agents-md/)、[Claude Code memory](https://code.claude.com/docs/en/memory)。实际使用前核对本机版本/加载配置；不能把本地路由测试当成所有基座的真实联调验收。

## 漂移检查与维护

check 检查指南注册/大小写/覆盖文件、篇幅、继承链预算、本地 inline Markdown 链接及简单标题锚点、主要索引完整性与入口篇幅。支持普通 inline 链接和 ATX 标题，不是完整 CommonMark/远端 URL 验证器。全部文档路径、30 模块、180 任务、E01–E52 和 schema 继续由原 docs 校验负责，不替换任何旧门禁。

新增规则应放在最窄的稳定目录；所有任务都适用才放根。一次性状态放任务记录，不放 AGENTS。新指南需更新 manifest；新 ADR/指南/执行/报告需更新对应索引。CI 的原 documentation job 无条件执行 harness 与其正反例，原 quality 流程也执行 Python 测试。

历史文件路径与失败证据保留，长状态流水归档。分支维护独立见 [维护索引](../maintenance/README.md)，不会因为一句 AGENTS 获得删除权限。
