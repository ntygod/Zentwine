import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppBoundary, Brand, ConnectionAlert, ConnectionBadge, useBootstrap } from '@zentwine/ui';
import { STUDIO_PATH, WORKBENCH_PATH } from '@zentwine/contracts';
import '@zentwine/ui/styles.css';
const studioUrl = `http://127.0.0.1:5174${STUDIO_PATH}`;
function Workbench() {
  const { connection, retry } = useBootstrap();
  const path = window.location.pathname;
  if (path !== '/' && path !== WORKBENCH_PATH) return <main className="fatal"><h1>页面不存在</h1><p>链接只用于定位，不会创建项目或启动执行。</p><a href={WORKBENCH_PATH}>返回工作台</a></main>;
  return <div className="layout"><a className="skip" href="#main">跳转到主要内容</a>
    <aside className="sidebar"><Brand/><div className="workspace-switch"><strong>本地开发空间</strong><small>工程基础 · 无业务数据</small></div>
      <nav aria-label="主导航" className="nav"><div className="nav-group-label">WORKSPACE</div><a href={WORKBENCH_PATH} aria-current="page">工作台 <span aria-hidden="true">⌂</span></a><a href={studioUrl} target="_blank" rel="noopener noreferrer">开发工作台 <span aria-hidden="true">↗</span></a>{['目标与机会','项目组合','需求与交付','执行中心','评审与发布'].map(label => <div className="unavailable" key={label}><span>{label}</span><small>待实现</small></div>)}<div className="nav-group-label" style={{marginTop:20}}>CAPABILITIES</div>{['团队知识','模型实验室','组织治理'].map(label => <div className="unavailable" key={label}><span>{label}</span><small>待实现</small></div>)}</nav>
      <div className="sidebar-footer"><a href="https://github.com/ntygod/Zentwine/tree/main/docs" target="_blank" rel="noopener noreferrer">开发计划与项目文档 ↗</a><small>基础能力按真实状态展示</small></div>
    </aside><div className="main-column"><header className="topbar"><span className="breadcrumb">本地开发空间 / 工作台</span><div className="topbar-right"><span className="pill">ENGINEERING PREVIEW</span><ConnectionBadge connection={connection}/></div></header>
      <main className="page" id="main"><div className="page-header"><div><div className="eyebrow">BUILD TOGETHER. DELIVER AS ONE.</div><h1>团队的下一次协作，从这里开始。</h1><p>管理工作台与独立 Studio，共用一套事实与交付边界。</p></div><a className="primary-link" href={studioUrl} target="_blank" rel="noopener noreferrer">打开独立 Studio <span aria-hidden="true">↗</span></a></div>
        <ConnectionAlert connection={connection} retry={retry}/><div className="notice"><strong>当前为工程基础版本。</strong> 页面连接真实只读 API；身份、持久化与模型执行尚未接通。没有创建任何项目、工作区或 Run。</div>
        <section className="hero" aria-label="工作入口"><div><div className="eyebrow">ONE TEAM · MANY INTELLIGENCES</div><h2>从共同的目标，走向<br/>可以验证的交付。</h2><p>为需求、团队和不同模型建立共同的工作环境。先把上下文与责任连接，再让执行持续向前。</p><div className="hero-links"><a className="primary-link" href={studioUrl} target="_blank" rel="noopener noreferrer">进入开发空间 ↗</a><a className="subtle-link" href="https://github.com/ntygod/Zentwine" target="_blank" rel="noopener noreferrer">查看工程进展</a></div></div><div className="journey">{[['01','明确需求与约定','批准的目标，版本化的上下文'],['02','组织人机协作','独立工作区，清晰分工与授权'],['03','依据证据交付','代码、验证与验收相互关联']].map(([n,title,desc]) => <div className="journey-step" key={n}><span className="step-number">{n}</span><div><strong>{title}</strong><small>{desc}</small></div></div>)}</div></section>
        <div className="grid-two"><section className="card"><header className="card-header"><h2>交付空间</h2><span className="state-off">尚未接通</span></header><div className="empty"><div className="empty-symbol" aria-hidden="true">◇</div><h3>还没有可读取的交付单元</h3><p>组织身份与业务持久化完成后，这里将展示真实项目。不使用样例进度或虚构任务填充看板。</p><span className="muted">下一阶段：组织 · 需求 · 工作包</span></div></section>
        <section className="card"><header className="card-header"><h2>Agent 基座</h2><span className="state-off">执行关闭</span></header><div className="runtime-list">{['Claude Agent SDK','Codex'].map((name,index) => <div className="runtime" key={name}><div className="runtime-name"><span className="runtime-icon" aria-hidden="true">{index === 0 ? 'C' : '◇'}</span><div><strong>{name}</strong><small>运行时适配计划 · 未发送模型请求</small></div></div><span className="state-off">未连接</span></div>)}</div><div className="card-note">打开页面不会启动 Agent，也不会产生模型费用。</div></section></div>
        <footer className="page-footer"><span>系统模式：{connection.status === 'ready' ? connection.data.mode : '状态读取中或不可用'}</span><span>开发者保有控制权 · 完成需要证据</span></footer>
      </main></div></div>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing app root');
createRoot(root).render(<StrictMode><AppBoundary><Workbench/></AppBoundary></StrictMode>);
