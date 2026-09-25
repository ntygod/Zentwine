import { useState } from "react";
import type { EmergencyState, EmergencyResult, EmergencyReceipt } from "@zentwine/contracts";
interface Props {
  members: readonly { id: string; human_id: string; display_name: string }[];
  actor: string;
  target: string;
  state: EmergencyState | null;
  result: EmergencyResult | null;
  busy: boolean;
  retry: boolean;
  onTarget: (id: string) => void;
  onLoad: () => void;
  onSubmit: (reason: EmergencyReceipt["reason"]) => void;
  onRetry: () => void;
}
export function EmergencyAccessPanel(p: Props) {
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState<"suspected_compromise" | "access_review">("suspected_compromise");
  const target = p.members.find((m) => m.id === p.target);
  return (
    <section className="card org-block org-emergency" aria-labelledby="emergency-title" aria-busy={p.busy}>
      <div className="eyebrow">GOVERNANCE · CONTAINMENT</div>
      <h2 id="emergency-title">成员应急访问控制</h2>
      <p>只影响当前组织的指定成员：阻断会话、资源和搜索访问，使其 Agent 委派与相关审批失效，并撤销相关待接受邀请。已返回的数据和已提交的操作无法收回。</p>
      <p>阻断持续有效，不会因重新登录或供应商同步解除。解除仅移除应急阻断，不恢复旧会话、旧委派、审批或邀请；底层成员角色和状态仍适用。其他组织不受影响。</p>
      <label>应急目标成员
        <select value={p.target} disabled={p.busy} onChange={(e) => { setConfirmation(""); p.onTarget(e.target.value); }}>
          <option value="">请选择其他成员</option>
          {p.members.filter((m) => m.human_id !== p.actor).map((m) => <option key={m.id} value={m.id}>{m.display_name} · {m.human_id}</option>)}
        </select>
      </label>
      <button disabled={p.busy || !p.target} onClick={() => { setConfirmation(""); p.onLoad(); }}>检查应急状态</button>
      {!p.state && <p role="status">操作前请读取最新状态。需要已安装 0007 迁移及受限管理角色授权。</p>}
      {p.state && target && <>
        <p role="status">{p.state.held ? "当前状态：应急阻断中" : "当前状态：未应急阻断"} · 安全版本 {p.state.version} · 成员状态 {p.state.membership_status}</p>
        <p className="org-emergency-identity">确认目标身份：{p.state.human_id}</p>
        {!p.state.held && <label>阻断原因
          <select value={reason} disabled={p.busy} onChange={(e) => setReason(e.target.value as typeof reason)}>
            <option value="suspected_compromise">疑似凭据或身份泄露</option>
            <option value="access_review">访问权限复核</option>
          </select>
        </label>}
        <label>输入目标身份编号确认
          <input value={confirmation} disabled={p.busy} autoComplete="off" onChange={(e) => setConfirmation(e.target.value)} />
        </label>
        <button disabled={p.busy || confirmation !== p.state.human_id} onClick={() => {
          setConfirmation(""); p.onSubmit(p.state?.held ? "incident_contained" : reason);
        }}>{p.state.held ? "确认解除应急阻断" : "确认应急阻断"}</button>
      </>}
      {p.retry && <div role="status">
        <p>上次操作尚未确认结果。不会自动重试；可重试同一请求获取回执，或检查当前状态。回执描述历史操作，当前状态以重新读取为准。</p>
        <button disabled={p.busy} onClick={p.onRetry}>重试同一应急请求</button>
      </div>}
      {p.result && <div role="status" className="org-emergency-receipt">
        <strong>{p.result.replayed ? "已取得原操作回执，未再次执行" : "应急操作已提交"}</strong>
        <p>操作：{p.result.receipt.action === "hold" ? "阻断" : "解除"} · 回执版本 {p.result.receipt.version} · 当前版本 {p.result.current.version}</p>
        <small>请求引用 {p.result.receipt.request_id}</small>
      </div>}
    </section>
  );
}
