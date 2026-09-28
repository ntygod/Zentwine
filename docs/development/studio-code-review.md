# Studio 本地代码变更审阅

ZT18-01-D / Issue #71。打开独立 Studio 首页，点击「审阅本地代码变更」。这是本地报告阅读器，不挂载仓库，不提供编辑、审批、合并或运行。

## 从 CLI 到界面

在可信 Linux 本机按 [固定提交比较指南](local-commit-comparison.md) 取得成功报告。以下 SHA/目录/路径是占位符，必须替换；shell 重定向由你显式保存报告，正文可能敏感，存到仓库外的专用位置。

```bash
node scripts/repository-compare.mjs /absolute/repository --base <完整baseSHA> --head <完整headSHA> > /private/location/listing.json
node scripts/repository-compare.mjs /absolute/repository --base <完整baseSHA> --head <完整headSHA> --path 'src/example.ts' > /private/location/detail.json
```

在页面选择 JSON 后，内容尚未读取；点击「导入比较报告」才读取并检查。先展示声明的两次提交和文件清单，按路径筛选、分页并点一个文件查看。只有报告原先明确携带的单文件正文可展开；缺正文不会自动调用 Git、读取目录或请求网络。新报告替换旧报告，而不是追加可信历史。

二进制/非UTF8、符号链接/子模块只显示不渲染原因。空文件或仅模式变化可能没有文本片段。差异是C的直接树比较，不是PR三点比较；三行上下文不是完整文件。逐行显示旧/新行号、增删符号、片段范围与缺失末尾换行。控制、BOM和双向字符显示为可见Unicode转义，HTML样式内容保持普通文本。

## 限额与故障

导入总文件4MiB、2000变更条目、4000差异行、100000 JSON节点/16层、文本hunk载荷1MiB；比CLI的大型元数据报告范围更窄。文件列表每页50条，代码每页100行。超限、重复键、未知字段/版本、失败CLI退出码、路径/分类/计数/行号矛盾均拒绝整份，错误不回显输入。

选择文件或替换文件先清除旧内容；清除、取消、关闭、刷新与切换回交接检查台不保留报告。读取10秒截止。报告仅存本窗口内存，不上传、不写localStorage/sessionStorage/IndexedDB/cookie。浏览器字符串和平台副本不保证擦除。

## 不能从结果推导什么

「报告格式已检查」不是「原仓库已验证」。SHA、代码和来源均为文件声明，浏览器不验证对象摘要、身份、组织权限或与本机文件的一致性。没有变更不代表工作区干净；来源自洽不代表可信；不能据此自动批准/执行/合并。原交接包检查台仍单独存在，两者不会互相授予权限。

## 验证与实现

构建后运行 `node --test tests/repository-comparison-import.test.mjs`；浏览器运行 `pnpm exec playwright test tests/browser/repository-comparison.spec.ts`。完整回归仍为原 `pnpm check` / quality CI。client负责解析与不可变投影，ui负责FileReader生命周期和文本渲染，app只组装。

参见 [ADR-036](../adr/ADR-036-studio-comparison-review.md)、[执行记录](../tasks/ZT18-01-D-execution.md)、[报告](../testing/zt18-01-d-report.md)。未完成 ZT17 全编辑器、持久Review、远端身份或真实执行；原业务阻断保持。
