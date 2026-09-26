import { Component, useEffect, useState, type ReactNode } from "react";
import { createClient, ClientError } from "@zentwine/client";
import type { Bootstrap } from "@zentwine/contracts";
const client = createClient();
export type Connection =
  | { status: "loading" }
  | { status: "ready"; data: Bootstrap }
  | { status: "error"; message: string; traceId: string | undefined };
export function useBootstrap(): { connection: Connection; retry: () => void } {
  const [connection, setConnection] = useState<Connection>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setConnection({ status: "loading" });
    void client
      .bootstrap(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setConnection({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setConnection({
            status: "error",
            message:
              error instanceof ClientError ? error.message : "无法读取服务状态",
            traceId: error instanceof ClientError ? error.traceId : undefined,
          });
      });
    return () => controller.abort();
  }, [attempt]);
  return { connection, retry: () => setAttempt((value) => value + 1) };
}
export function ConnectionBadge({ connection }: { connection: Connection }) {
  return (
    <span className={`connection ${connection.status}`} role="status">
      <span aria-hidden="true">●</span>{" "}
      {connection.status === "ready"
        ? "本地 API 已连接"
        : connection.status === "error"
          ? "API 连接失败"
          : "正在连接 API"}
    </span>
  );
}
export function ConnectionAlert({
  connection,
  retry,
}: {
  connection: Connection;
  retry: () => void;
}) {
  if (connection.status !== "error") return null;
  return (
    <div className="alert" role="alert">
      <div>
        <strong>{connection.message}</strong>
        {connection.traceId && <small>追踪编号：{connection.traceId}</small>}
      </div>
      <button onClick={retry}>重新连接</button>
    </div>
  );
}
export function Brand({ studio = false }: { studio?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        Z
      </span>
      <div>
        <strong>Zentwine{studio ? " Studio" : ""}</strong>
        <small>众弦 · 不同的智能，同一个团队</small>
      </div>
    </div>
  );
}
export class AppBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <main className="fatal" role="alert">
          <h1>界面加载失败</h1>
          <p>你的执行不会因为刷新界面被重新启动。</p>
          <button onClick={() => window.location.reload()}>重新加载</button>
        </main>
      );
    return this.props.children;
  }
}

export * from "./tokens.js";
export * from "./theme.js";
export * from "./primitives.js";

export * from "./workbench.js";

export * from "./object-page.js";
export * from "./object-layout.js";
