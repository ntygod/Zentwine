# 固定任务基线与审阅交接输入

ZT18-01-H / Issue #79。在 [G 的终端核对](local-review-feedback.md) 上锁定调用方预期，适合多个 coding 工具先看意见分布、再分文件读取同一批反馈。仍是本地只读检查，不启动 Agent 或批准修改。

## 独立确定四项期望

先从任务约定确认 base/head 完整提交 SHA，再独立确认本次原比较报告和意见文件的 SHA-256。可在可信本机对已确认的两个文件运行 `sha256sum comparison.json review-notes.json`；之后各次调用复用相同值，不在每次读取时重新取新值冒充锁定。G 的摘要输出可以帮助对照，但自动照抄待核验报告不能证明它就是当前任务。

原文件仍放在仓库外指定目录，名称是 `comparison.json` 与 `review-notes.json`。安装冻结依赖并 `pnpm build` 后运行；下列目录和变量是占位，四个变量必须事先赋予已确认的小写完整值：

```bash
node scripts/repository-review-inspect.mjs /absolute/repository /private/feedback \
  --expected-base "$TASK_BASE" --expected-head "$TASK_HEAD" \
  --expected-report-sha256 "$REPORT_SHA256" \
  --expected-notes-sha256 "$NOTES_SHA256"
```

先用此命令只取文件分布。需要具体意见时，在**同一组四项参数**后追加 `--path 'src/example.ts'`。各次都重新检查输入和 Git，不缓存上次成功。指定路径仍精确匹配，不解释 glob/pathspec；不输出原代码差异正文。

四项参数必须全部提供或全部省略。部分配置、重复参数、HEAD/分支/简写、大写或混合40/64位提交ID均退出64，不降级。两个文件摘要为64位 SHA-256，与 Git 采用 SHA-1 或 SHA-256 无关。

## 结果与恢复

提供完整期望且所有检查成功时，除原 `comparison_verification: matches_local_git` 外，还返回 `feedback.expectation_verification: matches_explicit_pins`。全部省略时保持原输出且不含新字段；不应将旧观察模式的退出0当成已锁定任务。

错配退出2、feedback为null，fault.stage为expectation，code区分 `report_pin_mismatch`、`notes_pin_mismatch`、`base_pin_mismatch`、`head_pin_mismatch`。不输出期望值、实际值或部分意见。格式、本地Git、取消/期限及清理故障沿用原错误；四项匹配不能跳过这些检查。

报告排版/换行或意见JSON重新格式化也会改变字节摘要。出现错配时先确认任务和交接批次，不自动更新 pin 或重试未锁定模式；确实更换批次时，由调用方明确确认新的四项。

## 程序接口

```js
await inspectRepositoryReview(repository, feedbackDirectory, {
  expected: { baseCommit, headCommit, reportSha256, notesSha256 },
  path: "src/example.ts",
  signal,
});
```

`expected` 存在时必须是完整普通数据对象；传 undefined/null/空对象也拒绝。首次异步读取前复制四项，之后调用方修改对象不会改变在途操作。未传入时沿用 G；timeoutMs、原生 AbortSignal 与路径规则保持。

## 边界与验证

这只验证调用方提供的期望，不读取业务任务、认证署名/远端身份或授予权限。没有当前HEAD/index/工作树一致性检查；不能据此开始写入。摘要匹配也不代替 Git 复算、原意见绑定和文件采样。原报告/意见v1、Studio与Git端口不变，原有文件限额、取消、清理及非原子观察限制继续适用。命令参数中的提交与摘要可被本机进程工具看见，不用于传凭据。

构建后运行 `node --test tests/repository-review-pins.test.mjs tests/repository-review-inspect.test.mjs`；完整回归见 [验证路由](../harness/verification.md)。设计见 [ADR-040](../adr/ADR-040-pinned-review-feedback.md)，实际记录见 [执行](../tasks/ZT18-01-H-execution.md) 与 [验证](../testing/zt18-01-h-report.md)。
