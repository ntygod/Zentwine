import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  AppBoundary,
  Brand,
  ConnectionAlert,
  ConnectionBadge,
  useBootstrap,
} from "@zentwine/ui";
import { STUDIO_PATH, WORKBENCH_PATH } from "@zentwine/contracts";
import "@zentwine/ui/styles.css";
function Studio() {
  const { connection, retry } = useBootstrap();
  const home =
    window.location.pathname === "/" ||
    window.location.pathname === STUDIO_PATH;
  return (
    <div className="studio-theme">
      <a className="skip" href="#editor">
        跳转到开发区域
      </a>
      <header className="studio-topbar">
        <Brand studio />
        <div className="studio-controls">
          <ConnectionBadge connection={connection} />
          <a href={`http://127.0.0.1:5173${WORKBENCH_PATH}`}>
            返回管理工作台 ↗
          </a>
        </div>
      </header>
      <div className="studio-context">
        <span>
          本地开发空间 /{" "}
          <strong>{home ? "尚未选择工作区" : "工作区不可用"}</strong>
        </span>
        <span>无需求版本 · 无分支 · 未持有写入权</span>
      </div>
      <ConnectionAlert connection={connection} retry={retry} />
      <div className="studio-grid">
        <aside className="explorer" aria-label="资源管理器">
          <div className="panel-title">EXPLORER / 资源</div>
          <div className="file-row">⌄ 尚未挂载仓库</div>
          <p>当前未连接文件系统。不会读取本机目录，也不会自动克隆仓库。</p>
          <div className="panel-title" style={{ marginTop: 30 }}>
            CONTEXT / 任务上下文
          </div>
          <div className="file-row">需求与验收 · 未绑定</div>
          <div className="file-row">接口与约定 · 未绑定</div>
        </aside>
        <main className="editor-panel" id="editor">
          <div className="editor-tabs">
            <span className="editor-tab">欢迎使用 Studio</span>
          </div>
          <section className="studio-welcome">
            <div className="studio-empty-badge" aria-hidden="true">
              ⌘
            </div>
            <div className="eyebrow">YOUR FOCUSED DEVELOPMENT SPACE</div>
            <h1>{home ? "独立开发，不脱离团队。" : "无法打开这个工作区"}</h1>
            <p>
              {home
                ? "这里将承载代码、Agent、调试和预览。当前已接通基础入口和只读服务，尚未建立任何可执行工作区。"
                : "身份与工作区读取能力尚未实现，因此不返回资源内容，也不会创建新工作区。请从管理工作台进入已授权的工作。"}
            </p>
            <div className="studio-checks">
              <div className="studio-check">
                <span>服务连接</span>
                <small>
                  {connection.status === "ready"
                    ? "只读 API 已连接"
                    : connection.status === "error"
                      ? "连接失败"
                      : "连接中"}
                </small>
              </div>
              <div className="studio-check">
                <span>任务与需求版本</span>
                <small>未绑定</small>
              </div>
              <div className="studio-check">
                <span>工作区与写入控制</span>
                <small>未建立</small>
              </div>
              <div className="studio-check">
                <span>模型与执行</span>
                <small>未启动</small>
              </div>
            </div>
            <a
              className="primary-link"
              href={`http://127.0.0.1:5173${WORKBENCH_PATH}`}
            >
              返回管理工作台
            </a>
          </section>
          <section className="terminal" aria-label="运行区域">
            <div className="terminal-tabs">
              <span>终端</span>
              <span>测试</span>
              <span>运行日志</span>
            </div>
            <code>未连接执行环境。这里没有正在运行的 Shell 或 Agent。</code>
          </section>
        </main>
        <aside className="studio-agent" aria-label="Agent 协作">
          <div className="panel-title">AGENT COLLABORATION</div>
          {["Claude Agent SDK", "Codex"].map((name) => (
            <section className="agent-box" key={name}>
              <header>
                <strong>{name}</strong>
                <span className="state-off">未连接</span>
              </header>
              <p>角色、模型和运行时分别记录。接入前不显示虚构运行进度。</p>
            </section>
          ))}
          <p className="agent-note">
            启动执行必须是显式命令。
            <br />
            打开、刷新或重新连接这个窗口，不会创建 Run。
            <br />
            <br />
            本界面目前不提供代码编辑、审批或人工接手；这些能力按开发计划继续建设。
          </p>
        </aside>
      </div>
      <footer className="studio-statusbar">
        <span>Zentwine Studio · ENGINEERING PREVIEW</span>
        <span>未连接文件系统 · 未创建执行 · 无模型费用</span>
      </footer>
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
createRoot(root).render(
  <StrictMode>
    <AppBoundary>
      <Studio />
    </AppBoundary>
  </StrictMode>,
);
