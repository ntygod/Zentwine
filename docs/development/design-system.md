# ZT04-01｜共享视觉基础

工作台的「设计系统」链接打开 `/org/local/workbench/design-system`。这是明确标记的组件样例，不读取项目、不调用API或模型，也不签发权限。示例输入和按钮只修改页面内存。工作台、组织设置、独立Studio使用相同语义颜色。

## 入口与组件

`@zentwine/ui` 导出 `ThemeProvider`、`ThemeSelect`、`Icon`、`Button`、`TextField`、`Panel`、`StatusBadge` 与纯数据tokens；现有 `styles.css` 提供布局及控件规则。应用在根节点包裹ThemeProvider，所有子组件消费CSS自定义属性，不改document上的授权或会话状态。

主题为light、dark、contrast，默认system根据 `prefers-color-scheme` 响应系统变化。显式选择优先，重新选择system恢复跟随。选择只在当前窗口内存中，不写localStorage/sessionStorage/cookie，不跨窗口同步，刷新重新跟随系统；布局偏好持久化属于ZT04-03，不在本项伪装完成。系统forced-colors保留原生配色和焦点，不设置forced-color-adjust:none。

`packages/ui/src/tokens.ts` 是颜色唯一来源，CSS只引用语义变量。canvas/surface/raised是表面层级，text/muted是文字层级，accent/onAccent成对使用。info、success、warning、danger、neutral分别有明确前景与背景；border是装饰分隔，controlBorder用于识别可操作边界，focus用于键盘。间距、字号、圆角与等宽字体在共享CSS定义，不把某个颜色值当作业务状态。

字体使用系统栈和本机中文字体回退，不下载或发布字体文件，不请求外部图标库。Icon是内部固定SVG路径，默认装饰性aria-hidden；独立语义图标须传label。原生button/select/input保留键盘行为，默认Button为type=button，表单提交必须显式声明type=submit。

StatusBadge总是输出文字和不同图形，运行中、正在停止、未知明确分开。组件本身不自动设置live region，避免展示多个静态标签时反复播报；业务消费者必须根据真实状态选择，不能将样例标签当作执行证据。TextField关联label、hint、error与aria-invalid；错误文字不回显后端或输入内容。

## 验证与边界

纯tokens测试对全部主题的指定文本/背景组合计算相对亮度：普通主题不低于4.5:1，高对比主题这些指定组合不低于7:1；控件边界/焦点与指定表面不低于3:1。此项不是所有页面自动可访问性认证，消费者覆盖、操作流程和辅助技术仍需进一步验证。

新浏览器测试通过真实开发服务检查三主题、媒体变化、系统强制配色、键盘、320/390窄屏、中英文长标识与两倍根字号。独立PG浏览器测试使用真实负责人页面，核对外观变化前后数据库设置、写请求和浏览器存储不变。原有浏览器与PG权限回归保持。

运行既有 `pnpm check`、`pnpm test:e2e`、配置专用临时PG后的 `pnpm test:organizations-ui`。新测试自动进入原CI，不改迁移或必需门禁。最终精确head、源码、日志和制品见Issue #36关联PR，不沿用旧CI。

未实现ZT04-02授权导航、ZT04-03对象页、ZT04-04实时状态同步或ZT04-06完整可访问性流程验收。组织UI现有业务边界不变，Studio仍无代码编辑和实际执行。无生产部署、业务库迁移或真实模型调用。
