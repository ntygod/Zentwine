import { useState } from "react";
import { Brand, ThemeSelect, useApprovalInbox } from "@zentwine/ui";
import {
  approvalInboxFilters,
  catalogApprovalPath,
  organizationWorkbenchPath,
  WORKBENCH_PATH,
  type ApprovalInboxFilter,
  type ApprovalInboxLane,
  type ApprovalInboxSelection,
} from "@zentwine/contracts";
import "./team-workbench.css";
import "./approval-inbox.css";
const labels: Record<ApprovalInboxFilter, string> = {
  all: "全部可见状态",
  pending: "等待审核",
  approved: "已批准，未执行",
  issued: "许可已签发，结果待核验",
  rejected: "已拒绝",
  revoked: "已撤销",
  consumed: "已执行",
  expired: "未完成且已过期",
};
const errors: Record<string, string> = {
  forbidden: "当前身份不能读取所选列表。负责人范围不向普通成员或访客开放。",
  unavailable_resource: "当前组织或资源访问已失效，未保留旧列表。",
  version_conflict: "会话或权限版本已变化，请重新从第一页读取。",
  invalid_input:
    "筛选或分页游标无效、已过期或属于旧权限上下文。请从第一页重新读取。",
  invalid_response: "响应不符合当前组织及筛选条件，未显示返回的内容。",
  network_unavailable:
    "网络连接中断，旧列表已清空。恢复后只重新读取，不执行审批。",
  rate_limited: "请求过于频繁，请稍后手动刷新。",
};
function Filters({
  selection,
  owner,
  apply,
}: {
  selection: ApprovalInboxSelection;
  owner: boolean;
  apply: (lane: ApprovalInboxLane, state: ApprovalInboxFilter) => void;
}) {
  const [lane, setLane] = useState(selection.lane),
    [state, setState] = useState(selection.state);
  return (
    <form
      className="inbox-filters"
      aria-label="审批筛选"
      onSubmit={(e) => {
        e.preventDefault();
        apply(lane, state);
      }}
    >
      <label>
        申请范围
        <select
          aria-label="申请范围"
          value={lane}
          onChange={(e) => setLane(e.target.value as ApprovalInboxLane)}
        >
          <option value="mine">我的申请</option>
          {owner && <option value="review">其他成员申请（负责人）</option>}
        </select>
      </label>
      <label>
        记录状态
        <select
          aria-label="记录状态"
          value={state}
          onChange={(e) => setState(e.target.value as ApprovalInboxFilter)}
        >
          {approvalInboxFilters.map((s) => (
            <option key={s} value={s}>
              {labels[s]}
            </option>
          ))}
        </select>
      </label>
      <button>应用筛选</button>
    </form>
  );
}
export function ApprovalInboxPage({ org }: { org: string }) {
  const { state, reload, next, switchOrganization } = useApprovalInbox(org);
  const refresh = () =>
    void (state.status === "ready"
      ? reload(state.selection.lane, state.selection.state)
      : reload());
  return (
    <div className="team-workbench">
      <a className="skip" href="#inbox-main">
        跳转到主要内容
      </a>
      <header className="team-header">
        <Brand />
        <a href={WORKBENCH_PATH}>工程首页</a>
        <ThemeSelect />
      </header>
      <main
        id="inbox-main"
        className="team-main"
        aria-busy={state.status === "loading"}
      >
        <div className="eyebrow">TEAM · APPROVAL DISCOVERY</div>
        <h1>目录审批工作台</h1>
        <p>
          发现申请，再进入详情核对精确范围。这里不批准、不签发许可、不执行，也不批量处理。
        </p>
        <a href={organizationWorkbenchPath(org)}>返回组织工作台</a>
        {state.status === "loading" && (
          <p role="status">正在核验并读取，旧列表已清空…</p>
        )}
        {state.status === "disabled" && (
          <section role="status">
            <h2>组织服务尚未启用</h2>
            <p>请按开发指南准备现有身份、组织和审批服务。这里没有演示申请。</p>
          </section>
        )}
        {state.status === "anonymous" && (
          <section role="status">
            <h2>需要登录</h2>
            <a href={WORKBENCH_PATH + "/settings"}>前往本机登录</a>
          </section>
        )}
        {state.status === "choose" && (
          <section className="card team-card">
            <h2>请确认链接组织</h2>
            <p>打开链接不会切换组织。确认后重新读取目标组织的审批记录。</p>
            <button
              onClick={() =>
                void switchOrganization().then((p) => {
                  if (p) window.location.assign(p);
                })
              }
            >
              确认切换到链接组织
            </button>
          </section>
        )}
        {state.status === "suspended" && (
          <section role="status">
            <h2>离线或页面已暂停</h2>
            <p>恢复后从第一页重新核验，旧记录和游标不作为当前状态。</p>
            <button onClick={refresh}>重新读取审批</button>
          </section>
        )}
        {state.status === "error" && (
          <section className="team-error" role="alert">
            <h2>无法读取审批列表</h2>
            <p>{errors[state.code] ?? "服务暂不可用，未显示原始错误内容。"}</p>
            <button onClick={refresh}>从第一页重新读取</button>
          </section>
        )}
        {state.status === "ready" && (
          <>
            <section className="card team-card" aria-label="审批查询条件">
              <p>
                当前身份：
                <strong>{state.auth.session.human.display_name}</strong> ·{" "}
                {state.selection.lane === "mine"
                  ? "我的申请"
                  : "其他成员申请（负责人）"}
              </p>
              <Filters
                selection={state.selection}
                owner={state.member.role === "owner"}
                apply={(lane, status) => void reload(lane, status)}
              />
              <button onClick={refresh}>刷新审批列表</button>
              <p className="team-snapshot">
                读取时点：
                <time dateTime={state.page.observed_at}>
                  {state.page.observed_at}
                </time>
                （UTC）。每页最多20条，只含当前有权读取的记录，不提供隐藏条目数量。
              </p>
              <p>
                分页固定申请的创建范围，不固定历史权限或状态；他人处理后请刷新。游标15分钟内有效，服务重启或权限变化后须重新读取。这里不是实时待办计数。
              </p>
            </section>
            <section
              className="card team-card"
              aria-labelledby="inbox-results-title"
            >
              <h2 id="inbox-results-title">可见审批记录</h2>
              {state.page.entries.length ? (
                <ol className="inbox-records" aria-label="审批记录列表">
                  {state.page.entries.map((entry) => (
                    <li key={entry.id}>
                      <div className="inbox-record-heading">
                        <h3>拟登记名称：{entry.requested_name}</h3>
                        <strong>
                          {labels[entry.expired ? "expired" : entry.state]}
                        </strong>
                      </div>
                      <dl className="inbox-facts">
                        <div>
                          <dt>申请身份</dt>
                          <dd>{entry.requester_id}</dd>
                        </div>
                        <div>
                          <dt>目标资源</dt>
                          <dd>{entry.resource_id}</dd>
                        </div>
                        <div>
                          <dt>绑定目录版本 / 审批版本</dt>
                          <dd>
                            {entry.resource_version} / {entry.object_version}
                          </dd>
                        </div>
                        <div>
                          <dt>申请截止（UTC）</dt>
                          <dd>
                            <time dateTime={entry.expires_at}>
                              {entry.expires_at}
                            </time>
                          </dd>
                        </div>
                      </dl>
                      <a href={catalogApprovalPath(org, "inspect", entry.id)}>
                        核对审批详情
                      </a>
                      <small>
                        申请引用 {entry.id}
                        。列表状态不是执行许可，详情页会重新核验。
                      </small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p role="status">
                  当前筛选没有可见审批记录；不代表组织中没有其他申请。
                </p>
              )}
              <button
                disabled={state.page.next_cursor === null}
                onClick={() => void next()}
              >
                下一页审批
              </button>
              {state.page.next_cursor === null &&
                state.page.entries.length > 0 && (
                  <p>已到当前可见创建范围末尾。新申请或状态变化请刷新查看。</p>
                )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
