import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand } from "@zentwine/ui";
import { WORKBENCH_PATH } from "@zentwine/contracts";
import "./organization.css";
type Row = Record<string, unknown>;
interface Session {
  csrf_token: string;
  session: {
    id: string;
    human: { id: string; display_name: string };
    context_version: number;
    active_org_id: string | null;
    organizations: { id: string; display_name: string }[];
  };
}
interface Settings {
  org_id: string;
  display_name: string;
  locale: "zh-CN" | "en";
  time_zone: string;
  invitations_enabled: boolean;
  invite_ttl_hours: number;
  guest_ttl_days: number;
  object_version: number;
}
interface Member {
  id: string;
  human_id: string;
  display_name: string;
  display_number: string;
  role: "owner" | "member" | "viewer";
  access_kind: "member" | "guest";
  access_expires_at: string | null;
  status: "active" | "revoked";
  object_version: number;
  managed_by_connection: boolean;
}
interface Invitation {
  id: string;
  human_id: string;
  access_kind: string;
  state: string;
  expires_at: string;
  object_version: number;
}
interface Connection {
  id: string;
  display_name: string;
  issuer: string;
  client_id: string;
  enabled: boolean;
  object_version: number;
}
const object = (v: unknown): v is Row =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
function sessionValue(v: unknown): Session {
  if (
    !object(v) ||
    v["schema_version"] !== "1.0.0" ||
    typeof v["csrf_token"] !== "string" ||
    !object(v["session"])
  )
    throw new Error();
  const s = v["session"];
  if (
    !uuid(s["id"]) ||
    !object(s["human"]) ||
    !uuid(s["human"]["id"]) ||
    typeof s["human"]["display_name"] !== "string" ||
    !Number.isSafeInteger(s["context_version"]) ||
    (s["active_org_id"] !== null && !uuid(s["active_org_id"])) ||
    !Array.isArray(s["organizations"]) ||
    s["organizations"].length > 100 ||
    !s["organizations"].every(
      (x) =>
        object(x) && uuid(x["id"]) && typeof x["display_name"] === "string",
    )
  )
    throw new Error();
  return v as unknown as Session;
}
function settingsValue(v: unknown): Settings {
  if (
    !object(v) ||
    !uuid(v["org_id"]) ||
    typeof v["display_name"] !== "string" ||
    !["zh-CN", "en"].includes(String(v["locale"])) ||
    typeof v["time_zone"] !== "string" ||
    typeof v["invitations_enabled"] !== "boolean" ||
    !Number.isSafeInteger(v["invite_ttl_hours"]) ||
    !Number.isSafeInteger(v["guest_ttl_days"]) ||
    !Number.isSafeInteger(v["object_version"])
  )
    throw new Error();
  return v as unknown as Settings;
}
function memberValue(v: unknown): Member {
  if (
    !object(v) ||
    !uuid(v["id"]) ||
    !uuid(v["human_id"]) ||
    typeof v["display_name"] !== "string" ||
    typeof v["display_number"] !== "string" ||
    !["owner", "member", "viewer"].includes(String(v["role"])) ||
    !["member", "guest"].includes(String(v["access_kind"])) ||
    !["active", "revoked"].includes(String(v["status"])) ||
    !Number.isSafeInteger(v["object_version"]) ||
    typeof v["managed_by_connection"] !== "boolean" ||
    (v["access_expires_at"] !== null &&
      typeof v["access_expires_at"] !== "string")
  )
    throw new Error();
  return v as unknown as Member;
}
function invitationValue(v: unknown): Invitation {
  if (
    !object(v) ||
    !uuid(v["id"]) ||
    !uuid(v["human_id"]) ||
    !["pending", "accepted", "revoked", "expired"].includes(
      String(v["state"]),
    ) ||
    !["member", "guest"].includes(String(v["access_kind"])) ||
    typeof v["expires_at"] !== "string" ||
    !Number.isSafeInteger(v["object_version"])
  )
    throw new Error();
  return v as unknown as Invitation;
}
function connectionValue(v: unknown): Connection {
  if (
    !object(v) ||
    !uuid(v["id"]) ||
    typeof v["display_name"] !== "string" ||
    typeof v["issuer"] !== "string" ||
    typeof v["client_id"] !== "string" ||
    typeof v["enabled"] !== "boolean" ||
    !Number.isSafeInteger(v["object_version"])
  )
    throw new Error();
  return v as unknown as Connection;
}
function list<T>(v: unknown, parse: (x: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > 200) throw new Error();
  return v.map(parse);
}
class RequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const labels: Record<string, string> = {
  authentication_required: "登录已失效，请重新获取本机登录票据。",
  invalid_login: "登录票据无效、过期或已使用。",
  unavailable_resource: "当前会话没有访问权限，或组织会话已撤销。",
  version_conflict: "内容或权限版本已变化，请刷新后重新操作。",
  forbidden: "操作被权限或最后负责人保护规则拒绝。",
  invalid_input: "请检查输入内容和字段范围。",
  rate_limited: "请求过于频繁，本次未自动重试。",
  unavailable: "服务暂时不可用，本次未自动重试。",
};
/** No secrets or authority in URLs/localStorage. Generation guards discard responses from previous organizations. */
export function OrganizationConsole() {
  const [cap, setCap] = useState<"loading" | "disabled" | "ready" | "error">(
    "loading",
  );
  const [auth, setAuth] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [me, setMe] = useState<Member | null>(null),
    [settings, setSettings] = useState<Settings | null>(null),
    [members, setMembers] = useState<Member[]>([]),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [connections, setConnections] = useState<Connection[]>([]);
  const [ticket, setTicket] = useState(""),
    [acceptToken, setAcceptToken] = useState(""),
    [human, setHuman] = useState(""),
    [kind, setKind] = useState<"member" | "guest">("guest"),
    [resourceIds, setResourceIds] = useState(""),
    [invitationToken, setInvitationToken] = useState("");
  const [search, setSearch] = useState(""),
    [results, setResults] = useState<{ id: string; display_name: string }[]>(
      [],
    );
  const [providerName, setProviderName] = useState(""),
    [issuer, setIssuer] = useState(""),
    [clientId, setClientId] = useState("");
  const gen = useRef(0),
    controller = useRef<AbortController | null>(null),
    inviteRequest = useRef<string | null>(null);
  const clear = () => {
    setMe(null);
    setSettings(null);
    setMembers([]);
    setInvitations([]);
    setConnections([]);
    setResults([]);
    setInvitationToken("");
    inviteRequest.current = null;
  };
  const api = async (
    path: string,
    method = "GET",
    body?: unknown,
    s: Session | null = auth,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {};
    if (s) {
      headers["x-zentwine-context-version"] = String(s.session.context_version);
      headers["x-zentwine-csrf"] = s.csrf_token;
    }
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      headers["x-zentwine-client"] = "web";
    }
    const response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(controller.current ? { signal: controller.current.signal } : {}),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length > 1048576) throw new Error();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error();
    }
    if (!response.ok)
      throw new RequestError(
        object(value) && typeof value["code"] === "string"
          ? value["code"]
          : "unavailable",
      );
    return value;
  };
  const orgPath = (s: Session) => {
    const org = s.session.active_org_id;
    if (!uuid(org)) throw new Error();
    return `/api/v1/orgs/${org}`;
  };
  const load = async (s: Session, tick: number) => {
    if (!s.session.active_org_id) return;
    const base = orgPath(s),
      self = memberValue(
        await api(base + "/organization-self", "GET", undefined, s),
      );
    let data: {
      settings: Settings;
      members: Member[];
      invitations: Invitation[];
      connections: Connection[];
    } | null = null;
    if (self.role === "owner" && self.access_kind === "member") {
      const [st, ms, ins, cs] = await Promise.all([
        api(base + "/settings", "GET", undefined, s),
        api(base + "/members", "GET", undefined, s),
        api(base + "/invitations", "GET", undefined, s),
        api(base + "/identity-connections", "GET", undefined, s),
      ]);
      data = {
        settings: settingsValue(st),
        members: list(ms, memberValue),
        invitations: list(ins, invitationValue),
        connections: list(cs, connectionValue),
      };
    }
    if (gen.current !== tick) return;
    setMe(self);
    if (data) {
      setSettings(data.settings);
      setMembers(data.members);
      setInvitations(data.invitations);
      setConnections(data.connections);
    }
  };
  const run = (work: (tick: number) => Promise<void>) => {
    if (busy) return;
    const tick = ++gen.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    setError("");
    setNotice("");
    void work(tick)
      .catch((e) => {
        if (gen.current !== tick) return;
        if (
          e instanceof RequestError &&
          [
            "authentication_required",
            "unavailable_resource",
            "version_conflict",
            "forbidden",
          ].includes(e.code)
        ) {
          clear();
          if (e.code === "authentication_required") setAuth(null);
        }
        setError(
          e instanceof RequestError
            ? (labels[e.code] ?? "请求被拒绝，未显示原始服务器内容。")
            : "连接失败或响应格式不兼容；未自动重试操作。",
        );
      })
      .finally(() => {
        if (gen.current === tick) setBusy(false);
      });
  };
  const refresh = async (tick: number) => {
    const s = sessionValue(await api("/api/v1/auth/session"));
    if (gen.current !== tick) return;
    clear();
    setAuth(s);
    await load(s, tick);
  };
  useEffect(() => {
    const tick = ++gen.current;
    const abort = new AbortController();
    controller.current = abort;
    void (async () => {
      const c = await api("/api/v1/system/organization-capabilities");
      if (gen.current !== tick) return;
      if (
        !object(c) ||
        c["schema_version"] !== "1.0.0" ||
        typeof c["enabled"] !== "boolean"
      )
        throw new Error();
      if (!c["enabled"]) {
        setCap("disabled");
        return;
      }
      setCap("ready");
      try {
        await refresh(tick);
      } catch (e) {
        if (e instanceof RequestError && e.code === "authentication_required")
          return;
        throw e;
      }
    })().catch(() => {
      if (gen.current === tick) setCap("error");
    });
    return () => {
      gen.current++;
      abort.abort();
    };
  }, []);
  const submit = (e: FormEvent, fn: (tick: number) => Promise<void>) => {
    e.preventDefault();
    run(fn);
  };
  return (
    <div className="org-console">
      <header className="org-top">
        <Brand />
        <a href={WORKBENCH_PATH}>← 返回工作台</a>
        <span className="pill">本机组织管理</span>
      </header>
      <main>
        <div className="page-header">
          <div>
            <div className="eyebrow">TEAM · ACCESS · IDENTITY</div>
            <h1>组织设置与成员</h1>
            <p>邀请、身份供应商与授权变更共用真实的组织边界。</p>
          </div>
        </div>
        {cap === "loading" && <p role="status">正在检查组织服务…</p>}
        {cap === "disabled" && (
          <section className="card org-block">
            <h2>组织管理尚未启用</h2>
            <p>
              默认工程模式不连接身份数据库。请先按开发指南准备组织服务、迁移和独立运行角色。
            </p>
            <p>本页面没有演示成员，不会自动创建组织、发送邀请或启动模型。</p>
          </section>
        )}
        {cap === "error" && (
          <p role="alert">无法确认组织服务状态，请检查 API 后刷新页面。</p>
        )}
        {error && (
          <div className="org-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {cap === "ready" && !auth && (
          <form
            className="card org-block"
            onSubmit={(e) =>
              submit(e, async (tick) => {
                const input = ticket;
                setTicket("");
                const s = sessionValue(
                  await api(
                    "/api/v1/auth/login",
                    "POST",
                    { ticket: input },
                    null,
                  ),
                );
                if (gen.current !== tick) return;
                clear();
                setAuth(s);
                await load(s, tick);
              })
            }
          >
            <h2>本机登录</h2>
            <p>输入操作员签发的一次性票据。当前不是公开注册或企业 SSO 登录。</p>
            <label>
              一次性登录票据
              <input
                type="password"
                autoComplete="off"
                value={ticket}
                onChange={(e) => setTicket(e.target.value)}
                required
              />
            </label>
            <button disabled={busy}>登录</button>
          </form>
        )}
        {cap === "ready" && auth && (
          <>
            <section className="card org-block org-context">
              <div>
                <strong>{auth.session.human.display_name}</strong>
                <small>身份 {auth.session.human.id}</small>
              </div>
              <label>
                当前组织
                <select
                  aria-label="当前组织"
                  value={auth.session.active_org_id ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    const org = e.target.value;
                    if (!org) return;
                    clear();
                    run(async (tick) => {
                      const s = sessionValue(
                        await api("/api/v1/auth/organization", "POST", {
                          org_id: org,
                          expected_version: auth.session.context_version,
                        }),
                      );
                      if (gen.current !== tick) return;
                      setAuth(s);
                      await load(s, tick);
                    });
                  }}
                >
                  <option value="" disabled>
                    选择组织
                  </option>
                  {auth.session.organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={busy} onClick={() => run(refresh)}>
                刷新状态
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api("/api/v1/auth/logout", "POST", {});
                    clear();
                    setAuth(null);
                  })
                }
              >
                退出登录
              </button>
            </section>
            <form
              className="card org-block org-accept"
              onSubmit={(e) =>
                submit(e, async (tick) => {
                  const token = acceptToken;
                  setAcceptToken("");
                  await api("/api/v1/auth/invitations/accept", "POST", {
                    invitation_token: token,
                  });
                  await refresh(tick);
                  setNotice("邀请已接受，浏览器会话已轮换。");
                })
              }
            >
              <label>
                接受发给当前身份的邀请
                <input
                  type="password"
                  autoComplete="off"
                  value={acceptToken}
                  onChange={(e) => setAcceptToken(e.target.value)}
                  required
                />
              </label>
              <button disabled={busy}>接受邀请</button>
            </form>
            {me && (
              <section className="notice">
                <strong>
                  {me.access_kind === "guest" ? "外部访客" : "组织成员"} ·{" "}
                  {me.role}
                </strong>
                <span>
                  {me.access_kind === "guest"
                    ? " 仅能读取明确共享的资源；不能导出、写入或委派 Agent。"
                    : " 会话和资源权限会在每次请求时重新检查。"}
                </span>
                {me.access_expires_at && (
                  <small>
                    访问期限：{new Date(me.access_expires_at).toLocaleString()}
                  </small>
                )}
              </section>
            )}
            {settings && (
              <div className="org-grid">
                <form
                  className="card org-block"
                  onSubmit={(e) =>
                    submit(e, async (tick) => {
                      await api(orgPath(auth) + "/settings", "PATCH", {
                        display_name: settings.display_name,
                        locale: settings.locale,
                        time_zone: settings.time_zone,
                        invitations_enabled: settings.invitations_enabled,
                        invite_ttl_hours: settings.invite_ttl_hours,
                        guest_ttl_days: settings.guest_ttl_days,
                        expected_version: settings.object_version,
                      });
                      await refresh(tick);
                      setNotice("组织设置已保存；旧的未接受邀请已撤销。");
                    })
                  }
                >
                  <h2>
                    组织设置 <small>v{settings.object_version}</small>
                  </h2>
                  <label>
                    组织名称
                    <input
                      value={settings.display_name}
                      maxLength={120}
                      required
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          display_name: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="org-row">
                    <label>
                      语言
                      <select
                        value={settings.locale}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            locale: e.target.value as "zh-CN" | "en",
                          })
                        }
                      >
                        <option value="zh-CN">简体中文</option>
                        <option value="en">English</option>
                      </select>
                    </label>
                    <label>
                      时区
                      <input
                        value={settings.time_zone}
                        required
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            time_zone: e.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="org-check">
                    <input
                      type="checkbox"
                      checked={settings.invitations_enabled}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          invitations_enabled: e.target.checked,
                        })
                      }
                    />
                    允许创建邀请
                  </label>
                  <div className="org-row">
                    <label>
                      邀请有效期（小时）
                      <input
                        type="number"
                        min="1"
                        max="168"
                        value={settings.invite_ttl_hours}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            invite_ttl_hours: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      访客访问上限（天）
                      <input
                        type="number"
                        min="1"
                        max="30"
                        value={settings.guest_ttl_days}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            guest_ttl_days: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  </div>
                  <button disabled={busy}>保存设置</button>
                </form>
                <form
                  className="card org-block"
                  onSubmit={(e) =>
                    submit(e, async (tick) => {
                      inviteRequest.current ??= crypto.randomUUID();
                      const result = await api(
                        orgPath(auth) + "/invitations",
                        "POST",
                        {
                          request_id: inviteRequest.current,
                          human_id: human,
                          role: kind === "guest" ? "viewer" : "member",
                          access_kind: kind,
                          resource_ids:
                            kind === "guest"
                              ? resourceIds.split(/[\s,]+/).filter(Boolean)
                              : [],
                          expected_settings_version: settings.object_version,
                        },
                      );
                      if (
                        !object(result) ||
                        typeof result["credential_issued"] !== "boolean"
                      )
                        throw new Error();
                      const received = result["invitation_token"];
                      if (gen.current !== tick) return;
                      setInvitationToken(
                        typeof received === "string" ? received : "",
                      );
                      inviteRequest.current = null;
                      await load(auth, tick);
                      if (gen.current !== tick) return;
                      setNotice(
                        typeof received === "string"
                          ? "邀请凭据仅显示本次，请通过可信渠道交给对应用户。没有发送邮件。"
                          : "该请求已存在，原始凭据不能恢复；请撤销旧邀请后重新创建。",
                      );
                    })
                  }
                >
                  <h2>邀请成员或访客</h2>
                  <p>仅限已登记的人类身份，不根据邮箱自动创建或合并账号。</p>
                  <label>
                    受邀用户 ID
                    <input
                      value={human}
                      onChange={(e) => {
                        setHuman(e.target.value);
                        inviteRequest.current = null;
                      }}
                      required
                    />
                  </label>
                  <label>
                    访问类型
                    <select
                      value={kind}
                      onChange={(e) => {
                        setKind(e.target.value as "guest" | "member");
                        inviteRequest.current = null;
                      }}
                    >
                      <option value="guest">外部访客 · 仅共享资源只读</option>
                      <option value="member">内部成员</option>
                    </select>
                  </label>
                  {kind === "guest" && (
                    <label>
                      共享资源 ID（逗号分隔，最多 16 个）
                      <textarea
                        value={resourceIds}
                        onChange={(e) => {
                          setResourceIds(e.target.value);
                          inviteRequest.current = null;
                        }}
                        required
                      />
                    </label>
                  )}
                  <button disabled={busy || !settings.invitations_enabled}>
                    创建邀请
                  </button>
                  {invitationToken && (
                    <label>
                      本次邀请凭据
                      <input
                        aria-label="本次邀请凭据"
                        type="password"
                        readOnly
                        value={invitationToken}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(invitationToken)
                            .then(() =>
                              setNotice("凭据已复制；仅适用于指定受邀身份。"),
                            )
                            .catch(() => setError("剪贴板不可用，请手动复制。"))
                        }
                      >
                        复制凭据
                      </button>
                      <button
                        type="button"
                        onClick={() => setInvitationToken("")}
                      >
                        清除显示
                      </button>
                    </label>
                  )}
                </form>
              </div>
            )}
            {settings && (
              <section className="card org-block">
                <h2>成员与访问边界</h2>
                <div className="org-table">
                  <table>
                    <thead>
                      <tr>
                        <th>成员</th>
                        <th>角色</th>
                        <th>状态</th>
                        <th>来源／期限</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => (
                        <tr key={m.id}>
                          <td>
                            <strong>{m.display_name}</strong>
                            <small>{m.display_number}</small>
                          </td>
                          <td>
                            <select
                              aria-label={"角色 " + m.display_name}
                              value={m.role}
                              disabled={
                                busy ||
                                m.managed_by_connection ||
                                m.access_kind === "guest" ||
                                m.status !== "active"
                              }
                              onChange={(e) => {
                                const role = e.target.value;
                                run(async (tick) => {
                                  await api(
                                    orgPath(auth) + "/members/" + m.id,
                                    "PATCH",
                                    {
                                      role,
                                      status: m.status,
                                      expected_version: m.object_version,
                                    },
                                  );
                                  await refresh(tick);
                                });
                              }}
                            >
                              <option value="owner">负责人</option>
                              <option value="member">成员</option>
                              <option value="viewer">只读</option>
                            </select>
                          </td>
                          <td>
                            {m.status === "active" ? "有效" : "已撤销"} ·{" "}
                            {m.access_kind === "guest" ? "访客" : "成员"}
                          </td>
                          <td>
                            {m.managed_by_connection
                              ? "身份供应商管理"
                              : "本地管理"}
                            <small>
                              {m.access_expires_at
                                ? new Date(m.access_expires_at).toLocaleString()
                                : "无访客期限"}
                            </small>
                          </td>
                          <td>
                            <button
                              disabled={busy}
                              onClick={() =>
                                run(async (tick) => {
                                  await api(
                                    orgPath(auth) + "/sessions/revoke",
                                    "POST",
                                    { human_id: m.human_id },
                                  );
                                  await refresh(tick);
                                  setNotice(
                                    "此成员在当前组织的旧会话已撤销；其他组织不受此操作影响。",
                                  );
                                })
                              }
                            >
                              撤销组织会话
                            </button>
                            <button
                              disabled={
                                busy ||
                                m.status !== "active" ||
                                m.managed_by_connection
                              }
                              onClick={() =>
                                run(async (tick) => {
                                  await api(
                                    orgPath(auth) + "/members/" + m.id,
                                    "PATCH",
                                    {
                                      role: m.role,
                                      status: "revoked",
                                      expected_version: m.object_version,
                                    },
                                  );
                                  await refresh(tick);
                                })
                              }
                            >
                              移出组织
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p>
                  最后一位负责人不能通过此页面移除；受身份供应商管理的成员由供应商端口更新。
                </p>
              </section>
            )}
            {settings && (
              <section className="card org-block">
                <h2>邀请记录</h2>
                {invitations.length === 0 ? (
                  <p>尚无邀请。</p>
                ) : (
                  <div className="org-table">
                    <table>
                      <thead>
                        <tr>
                          <th>受邀身份</th>
                          <th>类型</th>
                          <th>状态</th>
                          <th>到期</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invitations.map((i) => (
                          <tr key={i.id}>
                            <td>{i.human_id}</td>
                            <td>{i.access_kind}</td>
                            <td>{i.state}</td>
                            <td>{new Date(i.expires_at).toLocaleString()}</td>
                            <td>
                              <button
                                disabled={busy || i.state !== "pending"}
                                onClick={() =>
                                  run(async (tick) => {
                                    await api(
                                      orgPath(auth) +
                                        "/invitations/" +
                                        i.id +
                                        "/revoke",
                                      "POST",
                                      { expected_version: i.object_version },
                                    );
                                    setInvitationToken("");
                                    await load(auth, tick);
                                  })
                                }
                              >
                                撤销邀请
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
            {me && (
              <form
                className="card org-block"
                onSubmit={(e) =>
                  submit(e, async (tick) => {
                    const rows = await api(
                      orgPath(auth) +
                        "/catalog/search?q=" +
                        encodeURIComponent(search),
                    );
                    const parsed = list(rows, (v) => {
                      if (
                        !object(v) ||
                        !uuid(v["id"]) ||
                        typeof v["display_name"] !== "string"
                      )
                        throw new Error();
                      return { id: v["id"], display_name: v["display_name"] };
                    });
                    if (gen.current === tick) setResults(parsed);
                  })
                }
              >
                <h2>可访问资源</h2>
                <p>
                  只返回有权读取的目录条目，最多 20 条；不返回隐藏资源的数量。
                </p>
                <label>
                  资源名称
                  <input
                    value={search}
                    maxLength={120}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <button disabled={busy}>搜索资源</button>
                <div className="org-results">
                  {results.map((r) => (
                    <div key={r.id}>
                      <strong>{r.display_name}</strong>
                      <small>{r.id}</small>
                    </div>
                  ))}
                </div>
              </form>
            )}
            {settings && (
              <section className="card org-block">
                <h2>身份供应商接入</h2>
                <p>
                  SSO 验证器尚未连接。这里保存版本化配置，SCIM
                  同步端口处理已绑定主体的启用／停用；不是完整供应商协议认证。
                </p>
                {connections.map((c) => (
                  <div className="org-provider" key={c.id}>
                    <div>
                      <strong>{c.display_name}</strong>
                      <small>
                        {c.issuer} · v{c.object_version}
                      </small>
                      <small>
                        适配端口：{c.enabled ? "允许" : "禁用"}
                        ；外部验证器：未配置
                      </small>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async (tick) => {
                          await api(
                            orgPath(auth) + "/identity-connections/" + c.id,
                            "PUT",
                            {
                              display_name: c.display_name,
                              issuer: c.issuer,
                              client_id: c.client_id,
                              enabled: !c.enabled,
                              expected_version: c.object_version,
                            },
                          );
                          await refresh(tick);
                        })
                      }
                    >
                      {c.enabled ? "禁用连接" : "启用端口"}
                    </button>
                  </div>
                ))}
                <form
                  className="org-provider-form"
                  onSubmit={(e) =>
                    submit(e, async (tick) => {
                      await api(
                        orgPath(auth) +
                          "/identity-connections/" +
                          crypto.randomUUID(),
                        "PUT",
                        {
                          display_name: providerName,
                          issuer,
                          client_id: clientId,
                          enabled: false,
                          expected_version: 0,
                        },
                      );
                      await load(auth, tick);
                      setProviderName("");
                      setIssuer("");
                      setClientId("");
                    })
                  }
                >
                  <label>
                    连接名称
                    <input
                      value={providerName}
                      onChange={(e) => setProviderName(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    精确 HTTPS Issuer
                    <input
                      type="url"
                      value={issuer}
                      onChange={(e) => setIssuer(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Client ID
                    <input
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      required
                    />
                  </label>
                  <button disabled={busy}>创建禁用配置</button>
                </form>
                <p>
                  凭据和外部主体绑定由本机操作员配置，不在浏览器签发管理员凭据。
                </p>
              </section>
            )}
          </>
        )}
        <footer className="page-footer">
          组织身份开发阶段 · 不会启动模型或自动部署服务
        </footer>
      </main>
    </div>
  );
}
