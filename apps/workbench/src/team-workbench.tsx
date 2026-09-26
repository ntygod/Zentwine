import { useState } from "react";
import { Brand, ThemeSelect, useOrganizationWorkbench } from "@zentwine/ui";
import {
  WORKBENCH_PATH,
  ORGANIZATIONS_PATH,
  organizationWorkbenchPath,
  workbenchNavigation,
  type WorkbenchView,
  type WorkbenchSession,
} from "@zentwine/contracts";
import "./team-workbench.css";
const labels: Record<WorkbenchView, string> = {
  overview: "组织概览",
  catalog: "可访问资源",
  governance: "组织治理",
};
const errors: Record<string, string> = {
  forbidden: "当前身份不能打开此页面。未显示受保护内容。",
  unavailable_resource: "此组织不可访问。请重新选择有权访问的组织。",
  version_conflict: "组织上下文已变化。旧数据已清空，请重新核验后操作。",
  network_unavailable: "连接不可用。旧数据已清空，操作不会自动重试。",
  invalid_response: "服务响应不兼容。未显示返回的内容。",
  invalid_input: "输入不符合要求，请检查后重试。",
  rate_limited: "请求过于频繁，请稍后手动重试。",
};
function OrganizationPicker({
  auth,
  requested,
  onSwitch,
}: {
  auth: WorkbenchSession;
  requested: string | null;
  onSwitch: (id: string) => void;
}) {
  const [selected, setSelected] = useState(
    requested ?? auth.session.active_org_id ?? "",
  );
  return (
    <form
      className="team-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (selected) onSwitch(selected);
      }}
    >
      <label>
        切换到组织
        <select
          aria-label="切换到组织"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          required
        >
          <option value="" disabled>
            请选择组织
          </option>
          {auth.session.organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.display_name}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={
          !selected ||
          !auth.session.organizations.some((o) => o.id === selected)
        }
      >
        确认切换组织
      </button>
      {auth.session.organizations.length === 0 && (
        <p>当前没有可进入的组织。通过已有邀请流程加入后重新核验。</p>
      )}
    </form>
  );
}
function ResourceSearch({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = useState("");
  return (
    <form
      className="team-picker"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(query);
      }}
    >
      <label>
        资源名称
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={120}
          autoComplete="off"
        />
      </label>
      <button>搜索可访问资源</button>
    </form>
  );
}
export function TeamWorkbench({
  org,
  view,
}: {
  org: string | null;
  view: WorkbenchView;
}) {
  const { state, reload, switchOrganization, logout } =
    useOrganizationWorkbench(org, view);
  const enter = (id: string) => {
    void switchOrganization(id).then((path) => {
      if (path) window.location.assign(path);
    });
  };
  const auth =
    state.status === "ready" || state.status === "choose" ? state.auth : null;
  return (
    <div className="team-workbench">
      <a className="skip" href="#team-main">
        跳转到主要内容
      </a>
      <header className="team-header">
        <Brand />
        <a href={WORKBENCH_PATH}>工程首页</a>
        <ThemeSelect />
      </header>
      <main
        id="team-main"
        className="team-main"
        aria-busy={state.status === "loading"}
      >
        <div className="eyebrow">TEAM · VERIFIED CONTEXT</div>
        <h1>{state.status === "ready" ? labels[view] : "组织工作台"}</h1>
        <p>页面和链接只读；切换组织须明确确认，不会创建工作区或启动 Run。</p>
        {state.status === "loading" && (
          <p role="status">正在重新核验组织与权限，旧内容已清空…</p>
        )}
        {state.status === "suspended" && (
          <section role="status">
            <h2>离线或页面已暂停</h2>
            <p>不把旧快照显示为当前状态。恢复连接或回到页面后重新核验。</p>
            <button onClick={() => void reload()}>重新核验</button>
          </section>
        )}
        {state.status === "disabled" && (
          <section role="status">
            <h2>组织服务尚未启用</h2>
            <p>
              请按开发指南准备身份与组织服务；这里不显示演示成员或虚构项目。
            </p>
          </section>
        )}
        {state.status === "anonymous" && (
          <section role="status">
            <h2>需要登录</h2>
            <p>
              登录已失效或尚未建立。请通过现有本机身份入口登录，再返回所需深链。
            </p>
            <a href={WORKBENCH_PATH + "/settings"}>前往本机登录</a>
          </section>
        )}
        {state.status === "error" && (
          <section className="team-error" role="alert">
            <h2>无法打开当前页面</h2>
            <p>
              {errors[state.code] ?? "服务暂时不可用，未显示原始错误内容。"}
            </p>
            <button onClick={() => void reload()}>重新核验</button>
            <a href={ORGANIZATIONS_PATH}>重新选择组织</a>
          </section>
        )}
        {auth && (
          <section className="team-context" aria-label="已核验会话">
            <strong>{auth.session.human.display_name}</strong>
            <p>组织列表来自当前会话，不代表可绕过每次请求的权限核验。</p>
            <OrganizationPicker
              key={auth.session.id + ":" + auth.session.context_version}
              auth={auth}
              requested={state.status === "choose" ? state.requested : org}
              onSwitch={enter}
            />
            <button onClick={() => void reload()}>重新核验</button>
            <button onClick={() => void logout()}>退出当前会话</button>
          </section>
        )}
        {state.status === "choose" && (
          <p role="status">
            {state.requested
              ? "链接指向另一组织。请确认切换后进入；打开链接本身不会改变当前组织。"
              : "选择组织并明确确认后进入。"}
          </p>
        )}
        {state.status === "ready" && (
          <>
            <nav className="team-nav" aria-label="组织导航">
              {workbenchNavigation(state.member).map((v) => (
                <a
                  key={v}
                  href={organizationWorkbenchPath(state.org, v)}
                  aria-current={v === view ? "page" : undefined}
                >
                  {labels[v]}
                </a>
              ))}
            </nav>
            <p className="team-snapshot">
              按次核验的快照，非实时推送。切页、搜索、回到窗口或恢复网络时重新读取；已返回的数据不能远程收回。
            </p>
            {view === "overview" && (
              <section className="card team-card">
                <h2>
                  {auth?.session.organizations.find((o) => o.id === state.org)
                    ?.display_name ?? "当前组织"}
                </h2>
                <p>
                  当前角色：{state.member.role} ·{" "}
                  {state.member.access_kind === "guest"
                    ? "外部访客"
                    : "组织成员"}
                </p>
                <p>
                  资源目录仅显示实际有权读取的条目；项目、需求和执行页面尚未接通，不提供可点击的伪业务入口。
                </p>
                <small>
                  成员关系 {state.member.id} · 权限版本{" "}
                  {state.member.object_version}
                </small>
              </section>
            )}
            {view === "catalog" && (
              <section className="card team-card">
                <h2>
                  {state.member.access_kind === "guest"
                    ? "明确共享的资源"
                    : "当前可访问目录"}
                </h2>
                <ResourceSearch onSearch={(q) => void reload(q)} />
                <p>
                  最多返回 20
                  条，不显示隐藏资源计数。此处只读目录，不打开文件或启动执行。
                </p>
                {state.resources.length ? (
                  <ul className="team-resources" aria-label="可访问资源列表">
                    {state.resources.map((r) => (
                      <li key={r.id}>
                        <strong>{r.display_name}</strong>
                        <small>
                          {r.kind} · {r.id}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p role="status">当前查询没有可访问条目。</p>
                )}
              </section>
            )}
            {view === "governance" && state.settings && (
              <section className="card team-card">
                <h2>负责人治理概览</h2>
                <dl>
                  <dt>组织名称</dt>
                  <dd>{state.settings.display_name}</dd>
                  <dt>展示时区</dt>
                  <dd>{state.settings.time_zone}</dd>
                  <dt>邀请</dt>
                  <dd>
                    {state.settings.invitations_enabled ? "允许" : "关闭"}
                  </dd>
                  <dt>设置版本</dt>
                  <dd>{state.settings.object_version}</dd>
                </dl>
                <p>
                  这里为只读概览。实际成员、邀请、审计和应急操作仍在既有组织控制台，进入后会重新检查当前会话与权限。
                </p>
                <a href={WORKBENCH_PATH + "/settings"}>进入组织设置与成员</a>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
