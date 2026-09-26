# ADR-020｜共享语义主题与无副作用组件样例

状态：Accepted（实现方向）；最终工作包验收以Issue #36关联PR为准。

## 背景与决定

ZT03-02-B仍受Issue #35迁移兼容阻断；它的关闭条件保持。规划中ZT04-01的明确前置仅ZT01-02，已满足，因此独立推进，不尝试受阻校验器写入，不进入ZT03-03。

工作台与Studio原来分别硬编码浅色与深色，组织表单还有独立颜色值。采用一份语义tokens、窗口级ThemeProvider和共享CSS。三种显式主题加system选项，不依赖网络、数据库、供应商SDK或第三方图标/字体库，不更改依赖锁。Studio的默认外观现在与系统偏好一致，可单独选择深色；不再将深色硬编码成Studio身份。

保留原生select/button/input，静态状态同时输出文字与SVG，不把颜色作为唯一信息。优先验证键盘与长文本，而不是宣称完整WCAG认证。组件展示页公开的只是固定样例，不读取任何组织数据。

## 取舍与风险

窗口内存偏好避免向身份存储引入新字段；代价是刷新重置、不同窗口不自动同步。组织权限、业务缓存与执行状态不依赖ThemeContext。后续持久化须单独设计，不把浏览器偏好当作授权。

主题改变触及既有CSS，因此必须重跑组织/审计/应急真实PG浏览器与独立Studio回归。常规边框与控件边界分开；forced-colors继续使用系统默认映射。色值组合的数学对比验证不证明第三方内容、所有页面或屏幕阅读器流程完整合规。

回退限于UI代码和样式，不涉及数据库迁移或权限撤回；回退同样需要完整前端与原回归。

## 参考

- W3C，Understanding SC 1.4.3: Contrast (Minimum)：https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum
- MDN，forced-colors：https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/forced-colors
- MDN，prefers-color-scheme：https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme

本轮参考用于文本对比与系统配色约束；不据此声称所有浏览器兼容性或认证。
