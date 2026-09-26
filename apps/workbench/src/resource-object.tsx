import "@zentwine/ui/object-page.css";
import { ObjectPageFrame, DecisionDrawer, useObjectLayout } from "@zentwine/ui";
import type {
  ResourceObjectSnapshot,
  WorkbenchMember,
} from "@zentwine/contracts";
const kinds = {
  project: "项目目录项",
  work_package: "工作包目录项",
  workspace: "工作区目录项",
  repository: "仓库目录项",
  artifact: "产物目录项",
  release: "发布目录项",
};
const environments = {
  development: "开发",
  staging: "预发布",
  production: "生产",
};
export function ResourceObjectContent({
  snapshot,
  member,
}: {
  snapshot: ResourceObjectSnapshot;
  member: WorkbenchMember;
}) {
  const { layout, message, change, save, reset } = useObjectLayout();
  const { resource: r, decision: d } = snapshot;
  return (
    <ObjectPageFrame
      title={r.display_name}
      density={layout.density}
      showInspector={layout.inspector === "shown"}
      summary={
        <>
          <p>
            {kinds[r.kind]} · 目录版本 v{r.object_version} ·{" "}
            {environments[r.environment]}
          </p>
          <p>
            这是服务器返回的目录登记信息，不是规格正文、内容修订或执行状态。
          </p>
        </>
      }
      controls={
        <>
          <label>
            阅读密度
            <select
              aria-label="阅读密度"
              value={layout.density}
              onChange={(e) =>
                change({
                  ...layout,
                  density: e.target.value as "comfortable" | "compact",
                })
              }
            >
              <option value="comfortable">舒适</option>
              <option value="compact">紧凑</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={layout.inspector === "shown"}
              onChange={(e) =>
                change({
                  ...layout,
                  inspector: e.target.checked ? "shown" : "hidden",
                })
              }
            />
            显示版本、证据与活动侧栏
          </label>
          <button type="button" onClick={save}>
            记住布局
          </button>
          <button type="button" onClick={reset}>
            重置布局
          </button>
          <p role="status">{message}</p>
        </>
      }
      formal={
        <>
          <dl className="zt-object-facts">
            <dt>资源 ID</dt>
            <dd>{r.id}</dd>
            <dt>所属组织</dt>
            <dd>{r.org_id}</dd>
            <dt>记录状态</dt>
            <dd>有效目录记录</dd>
            <dt>可见范围</dt>
            <dd>
              {r.visibility === "restricted"
                ? "受限；仍须逐次鉴权"
                : "组织内；仍须逐次鉴权"}
            </dd>
            <dt>敏感级别</dt>
            <dd>{r.sensitivity === "confidential" ? "机密" : "内部"}</dd>
            <dt>登记负责人身份</dt>
            <dd>{r.owner_human_id ?? "未登记（不推断负责人）"}</dd>
          </dl>
          <p>
            来源：当前组织的资源读取接口。每次打开、刷新及恢复页面均重新核验；这个快照不可复用为授权。
          </p>
          <DecisionDrawer title="读取判定 · 非批准" trigger="查看读取判定">
            <p>
              这是本次资源读取的历史判定，不是人类批准、内容签名或可复用执行许可。
            </p>
            <dl className="zt-object-facts">
              <dt>判定</dt>
              <dd>允许本次读取</dd>
              <dt>动作范围</dt>
              <dd>resource.read · 单个目录对象</dd>
              <dt>目标组织</dt>
              <dd>{r.org_id}</dd>
              <dt>目标对象</dt>
              <dd>{r.id}</dd>
              <dt>目录对象版本</dt>
              <dd>{d.resource_version}</dd>
              <dt>策略版本</dt>
              <dd>
                {d.policy_version} / 修订 {d.policy_revision}
              </dd>
              <dt>读取身份</dt>
              <dd>{member.human_id}</dd>
              <dt>成员权限版本</dt>
              <dd>{d.membership_version}</dd>
              <dt>服务端判定时间（UTC）</dt>
              <dd>
                <time dateTime={d.evaluated_at}>{d.evaluated_at}</time>
              </dd>
              <dt>判定截止（UTC，不可复用）</dt>
              <dd>
                <time dateTime={d.expires_at}>{d.expires_at}</time>
              </dd>
            </dl>
            <p>
              未提供内容修订、批准范围或批准责任人，因此此处不提供批准或执行操作。页面停留时间不延长权限。
            </p>
          </DecisionDrawer>
        </>
      }
      discussion={
        <>
          <p>
            对话服务尚未接通。这里不显示演示消息，不提供会被误认为已提交的输入框。
          </p>
          <p>协作意见、模型建议与正式记录分开；对话中的“同意”不能成为批准。</p>
        </>
      }
      inspector={
        <>
          <section>
            <h3>版本</h3>
            <p>当前目录版本：v{r.object_version}</p>
            <p>内容修订与版本历史尚未接通；目录版本不是内容摘要。</p>
          </section>
          <section>
            <h3>证据</h3>
            <p>证据接口尚未接通，不能推断“没有证据”或“验证已通过”。</p>
          </section>
          <section>
            <h3>活动</h3>
            <p>对象活动流尚未接通；组织审计不是本对象的完整历史。</p>
          </section>
          <section>
            <h3>内容决策</h3>
            <p>
              持久内容批准尚未接通。当前读取判定不授予写入、发布或启动 Run
              的权限。
            </p>
          </section>
        </>
      }
    />
  );
}
