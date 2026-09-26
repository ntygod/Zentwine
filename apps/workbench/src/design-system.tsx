import { useState } from "react";
import {
  Brand,
  Button,
  Icon,
  Panel,
  StatusBadge,
  ThemeSelect,
  THEME_TOKENS,
  THEME_LABELS,
  UI_STATES,
  TextField,
  useTheme,
  type UIState,
} from "@zentwine/ui";
import { WORKBENCH_PATH } from "@zentwine/contracts";
const stateDescriptions: Record<UIState, string> = {
  loading: "正在读取，不展示虚构百分比。",
  empty: "尚无记录，不等于读取失败。",
  error: "请求失败，不沿用上一次成功提示。",
  forbidden: "权限不足，不透露隐藏资源。",
  stale: "需要重新读取当前版本再操作。",
  offline: "连接已断开，不能假装实时。",
  running: "执行中不等于交付已完成。",
  stopping: "等待实际停止确认，不是假定已停止。",
  unknown: "尚不能确定结果，不自动重试。",
  success: "只表示所标注验证的结果。",
};
const swatches = [
  ["canvas", "页面底色"],
  ["surface", "内容表面"],
  ["accent", "可操作强调"],
  ["success", "确认结果"],
  ["warning", "需要关注"],
  ["danger", "失败与拒绝"],
  ["info", "信息与执行"],
  ["neutral", "中性与未知"],
  ["text", "主要文字"],
  ["focus", "键盘焦点"],
] as const;
/** Isolated visual specimens, not organization/project facts. No API client, storage or Run command. */
export function DesignSystemPage() {
  const { theme } = useTheme();
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState(
    "这里的按钮只更新本页示例，不保存业务数据。",
  );
  return (
    <div className="zt-gallery">
      <a className="skip" href="#foundation-main">
        跳转到组件内容
      </a>
      <header className="zt-gallery-top">
        <Brand />
        <div className="zt-gallery-controls">
          <a className="zt-foundation-link" href={WORKBENCH_PATH}>
            返回工作台
          </a>
          <ThemeSelect />
        </div>
      </header>
      <main id="foundation-main" tabIndex={-1}>
        <div className="zt-gallery-hero">
          <div>
            <div className="eyebrow">ZENTWINE / FOUNDATIONS 01</div>
            <h1>
              同一套语言，
              <br />
              让协作更清晰。
            </h1>
            <p>
              管理工作台与独立 Studio
              的共享视觉基础。颜色、文字和交互状态共同表达信息，而不是只靠一个绿点。
            </p>
          </div>
          <aside className="zt-gallery-note" aria-label="示例范围">
            <strong>
              <Icon name="palette" /> 组件样例 · 非业务数据
            </strong>
            <p>
              本页不读取项目、不连接模型、不授予权限。外观只在当前窗口内生效；刷新后重新跟随系统。
            </p>
            <p>当前主题：{THEME_LABELS[theme]}</p>
          </aside>
        </div>
        <nav className="zt-gallery-nav" aria-label="组件分类">
          <a href="#foundation-colors">01 语义颜色</a>
          <a href="#foundation-type">02 文字与布局</a>
          <a href="#foundation-states">03 真实状态</a>
          <a href="#foundation-controls">04 基础控件</a>
        </nav>
        <section
          id="foundation-colors"
          className="zt-gallery-section"
          aria-labelledby="colors-heading"
        >
          <h2 id="colors-heading">01 / 颜色各有职责</h2>
          <div className="zt-swatches">
            {swatches.map(([token, label]) => (
              <div key={token} className="zt-swatch">
                <div
                  className="zt-swatch-color"
                  style={{ background: THEME_TOKENS[theme][token] }}
                  aria-hidden="true"
                />
                <p>
                  {label}
                  <code>
                    {token} / {THEME_TOKENS[theme][token]}
                  </code>
                </p>
              </div>
            ))}
          </div>
        </section>
        <div className="zt-gallery-grid">
          <div id="foundation-type" className="zt-gallery-section">
            <Panel
              title="02 / 中英文，都要读得清"
              description="采用系统字体与本地中文字体回退；不加载远端字体。"
            >
              <p className="zt-type-sample">
                清晰的边界，可靠的协作。
                <br />
                Different intelligence.
                <br />
                One team.
              </p>
              <p>
                标题用于辨认当前任务，正文用于解释后果，辅助文字用于补充来源。中文自然换行，长英文标识也不能把页面撑出屏幕。
              </p>
              <div className="zt-specimen" data-long-sample>
                <small>长文本样例 · 非真实资源</small>
                <p>
                  团队共同检查同一个项目的最新版本与验收结果，仍需保留每项操作的责任和边界。
                </p>
                <p data-zt-mono>
                  {"sample_revision_" + "0123456789abcdef".repeat(6)}
                </p>
              </div>
            </Panel>
          </div>
          <div id="foundation-states" className="zt-gallery-section">
            <Panel
              title="03 / 状态必须说清楚"
              description="图形加文字，即使没有颜色也能区分。以下全部为展示样例。"
            >
              <ul className="zt-state-grid">
                {(Object.keys(UI_STATES) as UIState[]).map((state) => (
                  <li key={state}>
                    <StatusBadge state={state} />
                    <p>{stateDescriptions[state]}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
        <div id="foundation-controls" className="zt-gallery-section">
          <Panel
            title="04 / 有反馈，不制造副作用"
            description="键盘可操作，焦点可见；禁用必须有说明。"
          >
            <div className="zt-gallery-grid">
              <div>
                <div className="zt-demo-buttons">
                  <Button
                    variant="primary"
                    onClick={() =>
                      setMessage("已切换示例展示。没有保存、发送或启动执行。")
                    }
                  >
                    查看示例
                    <Icon name="arrow" />
                  </Button>
                  <Button
                    onClick={() => {
                      setValue("");
                      setSubmitted(false);
                      setMessage("示例已重置，业务数据没有变化。");
                    }}
                  >
                    重置示例
                  </Button>
                  <Button
                    variant="danger"
                    disabled
                    aria-describedby="disabled-note"
                  >
                    删除样例（不可用）
                  </Button>
                </div>
                <small id="disabled-note">
                  这不是删除入口；展示页没有删除能力。
                </small>
                <p role="status" className="zt-demo-message" aria-live="polite">
                  {message}
                </p>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setSubmitted(true);
                  setMessage(
                    value.trim()
                      ? "样例输入已检查，仅保留在当前页面内存。"
                      : "请填写样例名称；没有向服务器发送请求。",
                  );
                }}
                noValidate
              >
                <TextField
                  label="样例名称"
                  hint="仅用于展示输入状态，不保存或同步。"
                  value={value}
                  maxLength={120}
                  onChange={(event) => setValue(event.target.value)}
                  {...(submitted && !value.trim()
                    ? { error: "请填写样例名称。" }
                    : {})}
                />
                <Button type="submit">检查样例输入</Button>
              </form>
            </div>
          </Panel>
        </div>
      </main>
      <footer className="zt-gallery-footer">
        ZT04-01 ·
        视觉基础与组件样例，不代表项目、执行或审批能力已完成。系统强制配色保留浏览器默认行为。
      </footer>
    </div>
  );
}
