import { useState } from "react";
import {
  Brand,
  ThemeSelect,
  DecisionDrawer,
  useCatalogApproval,
} from "@zentwine/ui";
import {
  catalogApprovalPath,
  approvalInboxPath,
  catalogApprovalActions,
  resourceObjectPath,
  organizationWorkbenchPath,
  WORKBENCH_PATH,
  type CatalogApprovalRoute,
  type CatalogApproval,
  type WorkbenchMember,
  type ResourceObjectSnapshot,
} from "@zentwine/contracts";
import "./team-workbench.css";
import "./catalog-approval.css";
const statuses: Record<CatalogApproval["state"], string> = {
  pending: "等待独立负责人审核",
  approved: "已记录批准，尚未执行",
  issued: "许可已签发，执行结果须核验",
  rejected: "已拒绝，不会执行",
  revoked: "已撤销，不会执行",
  consumed: "改名已执行，回执已保存",
};
const reasons: Record<string, string> = {
  forbidden: "当前权限、有效期或操作规则不允许此请求。",
  unavailable_resource: "申请或资源不存在，或当前无权访问。",
  version_conflict:
    "版本或组织上下文已变化。请重新核验，不能使用旧确认覆盖新状态。",
  invalid_input: "输入不符合要求。",
  approval_required: "当前申请不能签发执行许可。",
  invalid_response: "响应未通过格式或摘要核对，未将其显示为成功。",
  network_unavailable: "连接中断，未自动重发操作。",
  rate_limited: "请求过于频繁，请稍后手动核验。",
};
function Confirmation({
  actions,
  names,
  act,
}: {
  actions: readonly ("approve" | "reject" | "execute" | "revoke")[];
  names: Record<"approve" | "reject" | "execute" | "revoke", string>;
  act: (a: "approve" | "reject" | "execute" | "revoke") => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <>
      <label className="catalog-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已核对目标版本、名称和责任人
      </label>
      <div className="catalog-actions">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={!confirmed}
            onClick={() => {
              setConfirmed(false);
              act(action);
            }}
          >
            {names[action]}
          </button>
        ))}
      </div>
    </>
  );
}
function Decision({
  a,
  member,
  act,
}: {
  a: CatalogApproval;
  member: WorkbenchMember;
  act: (action: "approve" | "reject" | "execute" | "revoke") => void;
}) {
  const actions = catalogApprovalActions(a, member);
  const actionNames = {
    approve: "批准此目录改名",
    reject: "拒绝此目录改名",
    execute: "执行已批准改名",
    revoke: "撤销此申请",
  } as const;
  return (
    <section
      className="card team-card"
      aria-labelledby="approval-decision-title"
    >
      <h2 id="approval-decision-title">目录操作决策</h2>
      <p role="status">{statuses[a.state]}</p>
      <p>
        记录状态不代表许可仍有效。所有命令重新检查权限、版本及到期；此处不是规格内容批准或
        Run 启动。
      </p>
      {a.decision ? (
        <dl className="catalog-approval-facts">
          <dt>决策来源</dt>
          <dd>
            {a.decision.source === "human"
              ? "独立人类负责人"
              : "历史策略预授权（非人类批准）"}
          </dd>
          <dt>决策责任身份</dt>
          <dd>{a.decision.actor_id}</dd>
          <dt>已记录决定</dt>
          <dd>{a.decision.outcome === "approve" ? "批准" : "拒绝"}</dd>
        </dl>
      ) : (
        <p>尚无批准人。申请人不能自行批准，即使其角色是负责人。</p>
      )}
      {a.state === "issued" && (
        <p className="catalog-caution">
          一次性许可不会恢复到页面。请先核验结果；仍为此状态时，撤销旧申请并重新走审批。不要重复签发或执行。
        </p>
      )}
      {actions.length > 0 && (
        <DecisionDrawer title="确认目录操作" trigger="打开目录操作确认">
          <p>
            请核对本次精确快照。批准不会立即改名；只有申请人点击执行，才会领取短期许可并提交目录改名。
          </p>
          <dl className="catalog-approval-facts">
            <dt>目标组织 / 对象</dt>
            <dd>
              {a.org_id} / {a.binding.resource_id}
            </dd>
            <dt>新名称</dt>
            <dd>{a.binding.display_name}</dd>
            <dt>目录版本 / 审批版本</dt>
            <dd>
              {a.binding.resource_version} / {a.object_version}
            </dd>
            <dt>绑定摘要</dt>
            <dd>{a.content_hash}</dd>
            <dt>申请责任身份</dt>
            <dd>{a.requester_id}</dd>
            <dt>本次操作身份</dt>
            <dd>{member.human_id}</dd>
          </dl>
          <Confirmation actions={actions} names={actionNames} act={act} />
          <p>
            没有自动重试。提交后断网不代表服务端回滚，应重新读取该申请核对。
          </p>
        </DecisionDrawer>
      )}
      {a.receipt && (
        <section aria-label="已提交执行回执">
          <h3>执行回执</h3>
          <p>
            实际登记名称：<strong>{a.receipt.resource.display_name}</strong>
          </p>
          <p>
            回执目录版本：{a.receipt.resource.object_version}
            。这是提交时的历史结果，不代替当前资源读取。
          </p>
          <a href={resourceObjectPath(a.org_id, a.binding.resource_id)}>
            重新读取资源详情
          </a>
        </section>
      )}
    </section>
  );
}
function RequestForm({
  resource,
  submit,
}: {
  resource: ResourceObjectSnapshot;
  submit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const reset = () => {
    setName("");
    setConfirmed(false);
  };
  return (
    <form
      className="card team-card"
      aria-label="新目录改名申请"
      onSubmit={(e) => {
        e.preventDefault();
        if (confirmed) {
          const submitted = name;
          reset();
          void submit(submitted);
        }
      }}
    >
      <h2>申请目录改名</h2>
      <dl className="catalog-approval-facts">
        <dt>当前登记名称</dt>
        <dd>{resource.resource.display_name}</dd>
        <dt>目标对象</dt>
        <dd>{resource.resource.id}</dd>
        <dt>目录版本 / 策略修订</dt>
        <dd>
          {resource.resource.object_version} /{" "}
          {resource.decision.policy_revision}
        </dd>
      </dl>
      <label>
        拟登记的新名称
        <input
          aria-label="拟登记的新名称"
          value={name}
          maxLength={120}
          required
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      <label className="catalog-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        仅申请改名，必须经另一名负责人审核
      </label>
      <button disabled={!confirmed || !name.trim()}>提交目录改名申请</button>
      <p>
        提交不会执行改名，也不会自动批准。是否有权申请仍由服务端检查；本界面始终要求独立审核。
      </p>
    </form>
  );
}
export function CatalogApprovalPage({
  route,
}: {
  route: CatalogApprovalRoute;
}) {
  const { state, reload, request, retryRequest, command, switchOrganization } =
    useCatalogApproval(route);
  const navigate = (path: string | null) => {
    if (path) window.location.assign(path);
  };
  return (
    <div className="team-workbench catalog-approval-page">
      <a className="skip" href="#approval-main">
        跳转到主要内容
      </a>
      <header className="team-header">
        <Brand />
        <a href={WORKBENCH_PATH}>工程首页</a>
        <a href={approvalInboxPath(route.org)}>目录审批工作台</a>
        <ThemeSelect />
      </header>
      <main
        id="approval-main"
        className="team-main"
        aria-busy={state.status === "loading"}
      >
        <div className="eyebrow">CATALOG · INDEPENDENT REVIEW</div>
        <h1>目录改名协作</h1>
        <p>
          申请 → 独立审核 →
          申请人明确执行。仅修改目录登记名称，不修改正文、不发布、不启动模型或
          Run。
        </p>
        {state.status === "loading" && (
          <p role="status">
            正在处理并核验，旧内容已清空。请勿把等待当作已执行。
          </p>
        )}
        {state.status === "disabled" && (
          <section role="status">
            <h2>组织服务尚未启用</h2>
            <p>请先准备既有身份、组织与目录审批服务；不使用演示申请。</p>
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
            <h2>链接指向另一组织</h2>
            <p>
              打开链接不会自动切换，也不会提交改名。请确认当前身份与目标组织。
            </p>
            <p>身份：{state.auth.session.human.display_name}</p>
            <p>
              目标组织：
              {
                state.auth.session.organizations.find((o) => o.id === route.org)
                  ?.display_name
              }
            </p>
            <button
              onClick={() => {
                void switchOrganization();
              }}
            >
              确认切换到链接组织
            </button>
          </section>
        )}
        {state.status === "error" && (
          <section className="team-error" role="alert">
            <h2>本次请求未完成核验</h2>
            <p>
              {reasons[state.code] ?? "服务暂时不可用，未显示原始错误内容。"}
            </p>
            {state.uncertain && (
              <p>
                提交结果尚未确认：可能已在服务端生效。不会自动重发，请先重新核验结果。
              </p>
            )}
            <button
              onClick={() => {
                void reload();
              }}
            >
              重新核验结果
            </button>
          </section>
        )}
        {state.status === "suspended" && (
          <section role="status">
            <h2>离线或页面已暂停</h2>
            <p>
              保护内容已清空。恢复后只读取状态，不自动提交命令；在途写入可能已经提交。
            </p>
            <button
              onClick={() => {
                void reload();
              }}
            >
              重新核验结果
            </button>
          </section>
        )}
        {state.status === "ready" && (
          <>
            <section className="team-context" aria-label="当前操作身份">
              <strong>{state.auth.session.human.display_name}</strong>
              <small>{state.member.human_id}</small>
              <p>此页是按次读取的快照，命令由服务端重新鉴权。</p>
              <button
                onClick={() => {
                  void reload();
                }}
              >
                重新核验结果
              </button>
              <a href={organizationWorkbenchPath(route.org, "catalog")}>
                返回资源目录
              </a>
            </section>
            {state.uncertain && !state.retryRequest && (
              <p role="status">
                原提交结果未确认且会话上下文已变化，本窗口不能重新提交。请由负责人核查原申请，勿盲目创建重复请求。
              </p>
            )}
            {state.retryRequest ? (
              <section className="card team-card" role="status">
                <h2>原申请结果未确认</h2>
                <p>
                  仅在本窗口、原会话和原组织上下文内，可以明确重试同一请求获取记录；不会生成新的请求
                  ID。刷新或离开会丢失此内存恢复入口。
                </p>
                <button
                  onClick={() => {
                    void retryRequest().then(navigate);
                  }}
                >
                  重试同一改名申请
                </button>
              </section>
            ) : (
              state.resource &&
              !state.approval &&
              !state.uncertain && (
                <RequestForm
                  resource={state.resource}
                  submit={(value) => {
                    void request(value).then(navigate);
                  }}
                />
              )
            )}
            {state.approval && route.mode === "request" && (
              <section className="card team-card" role="status">
                <h2>申请已记录，正在打开详情</h2>
                <p>当前仍是申请入口，审核与执行只在该申请的独立详情页进行。</p>
                <a
                  href={catalogApprovalPath(
                    route.org,
                    "inspect",
                    state.approval.id,
                  )}
                >
                  前往已记录的审批
                </a>
              </section>
            )}
            {state.approval && route.mode === "inspect" && (
              <>
                <section className="card team-card" aria-label="精确审批范围">
                  <h2>精确审批范围</h2>
                  <dl className="catalog-approval-facts">
                    <dt>申请 ID</dt>
                    <dd>{state.approval.id}</dd>
                    <dt>目标组织</dt>
                    <dd>{state.approval.org_id}</dd>
                    <dt>目标对象</dt>
                    <dd>{state.approval.binding.resource_id}</dd>
                    <dt>操作</dt>
                    <dd>catalog.rename · resource.update</dd>
                    <dt>拟登记名称</dt>
                    <dd>{state.approval.binding.display_name}</dd>
                    <dt>目录版本 / 策略修订</dt>
                    <dd>
                      {state.approval.binding.resource_version} /{" "}
                      {state.approval.binding.policy_revision}
                    </dd>
                    <dt>审批记录版本</dt>
                    <dd>{state.approval.object_version}</dd>
                    <dt>申请责任身份</dt>
                    <dd>{state.approval.requester_id}</dd>
                    <dt>绑定摘要（SHA-256）</dt>
                    <dd>{state.approval.content_hash}</dd>
                    <dt>申请截止（UTC）</dt>
                    <dd>
                      <time dateTime={state.approval.expires_at}>
                        {state.approval.expires_at}
                      </time>
                    </dd>
                  </dl>
                  <a
                    href={catalogApprovalPath(
                      route.org,
                      "inspect",
                      state.approval.id,
                    )}
                  >
                    此申请的审核链接
                  </a>
                  <p>
                    链接只定位，接收人必须独立登录并具有读取与审批权限。此摘要绑定目录操作，不是内容修订摘要。
                  </p>
                </section>
                <Decision
                  key={
                    state.approval.id +
                    ":" +
                    state.approval.object_version +
                    ":" +
                    state.auth.session.id
                  }
                  a={state.approval}
                  member={state.member}
                  act={(action) => {
                    void command(action);
                  }}
                />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
