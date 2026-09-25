import {
  organizationAuditKinds,
  type OrganizationAuditKind,
  type OrganizationAuditPage,
} from "@zentwine/contracts";
export const auditLabels: Record<OrganizationAuditKind, string> = {
  "settings.updated": "组织设置已更新",
  "member.updated": "成员权限已变更",
  "sessions.revoked": "组织会话已撤销",
  "invitation.created": "邀请已创建",
  "invitation.accepted": "邀请已接受",
  "invitation.revoked": "邀请已撤销",
  "connection.updated": "身份连接已更新",
  "identity.linked": "外部身份已绑定",
  "identity.provisioned": "身份同步已提交",
  "member.emergency_held": "成员已应急阻断",
  "member.emergency_released": "成员应急阻断已解除",
};
const subjects = {
  organization: "组织",
  membership: "成员关系",
  human: "人员身份",
  invitation: "邀请",
  identity_connection: "身份连接",
  external_identity: "外部身份映射",
};
interface Props {
  page: OrganizationAuditPage | null;
  kind: OrganizationAuditKind | "all";
  busy: boolean;
  onKind: (kind: OrganizationAuditKind | "all") => void;
  onLoad: (cursor?: string) => void;
}
export function OrganizationAuditPanel({
  page,
  kind,
  busy,
  onKind,
  onLoad,
}: Props) {
  return (
    <section
      className="card org-block org-audit"
      aria-labelledby="org-audit-title"
      aria-busy={busy}
    >
      <div className="org-audit-heading">
        <div>
          <div className="eyebrow">GOVERNANCE · HISTORY</div>
          <h2 id="org-audit-title">组织审计记录</h2>
        </div>
        <span className="pill">负责人只读</span>
      </div>
      <p>
        仅显示已记录的组织生命周期事件，不是完整审计账本。记录不包含凭据、邮箱、资源名称或原始请求；身份编号仍可用于追溯。
      </p>
      <p>
        当前不覆盖登录失败、资源访问、Agent
        执行和完整审批轨迹。供应商事件归因于连接，原记录未提供操作员身份。
      </p>
      <div className="org-audit-controls">
        <label>
          审计事件类型
          <select
            value={kind}
            disabled={busy}
            onChange={(e) =>
              onKind(e.target.value as OrganizationAuditKind | "all")
            }
          >
            <option value="all">全部已记录事件</option>
            {organizationAuditKinds.map((k) => (
              <option value={k} key={k}>
                {auditLabels[k]}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy} onClick={() => onLoad()}>
          刷新审计记录
        </button>
      </div>
      {!page && <p role="status">请选择类型后刷新，读取当前组织的真实记录。</p>}
      {page && (
        <>
          <p className="org-audit-snapshot">
            快照：{new Date(page.snapshot_at).toLocaleString()} ·
            最新在前，每页最多 20 条。新事件请刷新查看，分页游标在当前服务实例内
            15 分钟有效，重启后请刷新。
          </p>
          {page.entries.length === 0 ? (
            <p role="status">当前筛选没有已记录事件。</p>
          ) : (
            <ol className="org-audit-list" aria-label="审计事件列表">
              {page.entries.map((e) => (
                <li key={e.reference}>
                  <div className="org-audit-event-title">
                    <strong>{auditLabels[e.kind]}</strong>
                    <time dateTime={e.occurred_at}>
                      {new Date(e.occurred_at).toLocaleString()}
                    </time>
                  </div>
                  <dl>
                    <div>
                      <dt>
                        {e.actor_kind === "human" ? "操作身份" : "归因连接"}
                      </dt>
                      <dd>{e.actor_id}</dd>
                    </div>
                    <div>
                      <dt>{subjects[e.subject_kind]}</dt>
                      <dd>{e.subject_id}</dd>
                    </div>
                  </dl>
                  <small>事件引用 {e.reference}</small>
                </li>
              ))}
            </ol>
          )}
          <button
            disabled={busy || page.next_cursor === null}
            onClick={() => {
              if (page.next_cursor) onLoad(page.next_cursor);
            }}
          >
            下一页审计记录
          </button>
          {page.next_cursor === null && page.entries.length > 0 && (
            <small>已到此快照末尾；这不代表其他类型的行为已被审计。</small>
          )}
        </>
      )}
    </section>
  );
}
