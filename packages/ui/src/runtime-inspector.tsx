import { useEffect, useRef, useState } from "react";
import {
  createRuntimeInputInspection,
  RUNTIME_INSPECTION_PLAN_BYTES,
  type RuntimeInputBundle,
  type RuntimeInputBundleSnapshot,
} from "@zentwine/client";

type Selection = {
  producers: Record<string, File>;
  artifacts: Record<string, File>;
};
const emptySelection = (): Selection => ({ producers: {}, artifacts: {} });
const statuses: Record<string, string> = {
  idle: "待选择文件",
  awaiting_producers: "正在核对生产事件",
  awaiting_artifacts: "生产报告已匹配",
  reading_artifacts: "正在核对产物字节",
  ready: "字节校验通过（未授权执行）",
  rejected: "检查未通过",
  closed: "已清除",
};
const itemStatuses: Record<string, string> = {
  idle: "未检查",
  observing: "核对中",
  reading: "读取中",
  checking: "摘要核对中",
  matched: "匹配",
  closed: "已释放",
  rejected: "拒绝",
};

/** Explicit local file inspection only. No source fetching, body preview or execution. */
export function RuntimeInspector({ onClose }: { onClose: () => void }) {
  const active = useRef<RuntimeInputBundle | null>(null);
  const generation = useRef(0);
  const selection = useRef<Selection>(emptySelection());
  const [revision, setRevision] = useState(0);
  const [plan, setPlan] = useState<RuntimeInputBundleSnapshot | null>(null);
  const [result, setResult] = useState<RuntimeInputBundleSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(
    () => () => {
      generation.current++;
      active.current?.close();
      active.current = null;
      selection.current = emptySelection();
    },
    [],
  );

  function clear() {
    generation.current++;
    active.current?.close();
    active.current = null;
    selection.current = emptySelection();
    setPlan(null);
    setResult(null);
    setLoading(false);
    setStarted(false);
    setError("");
    setSelected(0);
    setRevision((n) => n + 1);
  }
  async function load(file: File | undefined) {
    clear();
    if (!file) return;
    const token = generation.current;
    if (file.size > RUNTIME_INSPECTION_PLAN_BYTES) {
      setError("计划文件超过 256 KiB 上限。");
      return;
    }
    setLoading(true);
    try {
      const bytes = await file.arrayBuffer();
      if (token !== generation.current) return;
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      const bundle = createRuntimeInputInspection(text);
      active.current = bundle;
      setPlan(bundle.getSnapshot());
      setResult(bundle.getSnapshot());
    } catch {
      if (token === generation.current)
        setError(
          "无法读取计划：请核对 JSON 格式、版本、输入引用与容量。文件内容不会回显。",
        );
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }
  function choose(
    kind: keyof Selection,
    id: string,
    file: File | undefined,
    maximum: number,
  ) {
    if (started) return;
    delete selection.current[kind][id];
    setError("");
    if (file && file.size <= maximum) selection.current[kind][id] = file;
    else if (file) setError("所选文件超过此条目的长度或容量上限，请重新选择。");
    setSelected(
      Object.keys(selection.current.producers).length +
        Object.keys(selection.current.artifacts).length,
    );
  }
  async function inspect() {
    const bundle = active.current;
    if (!bundle || !plan || started || bundle.getSnapshot().status !== "idle")
      return;
    const files = selection.current;
    if (selected !== plan.producers.length + plan.artifacts.length) {
      setError("请为每个生产者和输入产物选择文件。");
      return;
    }
    setStarted(true);
    setError("");
    const token = generation.current;
    const publish = () => {
      if (token === generation.current) setResult(bundle.getSnapshot());
    };
    try {
      bundle.begin();
      publish();
      await Promise.all(
        plan.producers.map(async (p) => {
          const pending = bundle.observeProducer(
            p.manifest_id,
            files.producers[p.manifest_id]!.stream(),
          );
          publish();
          await pending;
          publish();
        }),
      );
      if (token !== generation.current) return;
      // Do not open any artifact stream until every producer report has passed.
      if (bundle.getSnapshot().status === "awaiting_artifacts") {
        await Promise.all(
          plan.artifacts.map(async (a) => {
            const id = a.binding!.artifact.ref.artifact_id;
            const pending = bundle.readArtifact(
              id,
              files.artifacts[id]!.stream(),
            );
            publish();
            await pending;
            publish();
          }),
        );
      }
      if (token !== generation.current) return;
      publish();
      if (bundle.getSnapshot().status !== "ready")
        setError("检查未通过：生产报告或产物字节不匹配。未交付任何内容。");
    } catch {
      if (token === generation.current) {
        setResult(null);
        setError("检查中断，未交付任何内容。请清除后重新选择。");
      }
    } finally {
      // This surface only displays metadata. Never takeAll, preview or export bytes.
      bundle.close();
      if (token === generation.current) {
        active.current = null;
        selection.current = emptySelection();
        setRevision((n) => n + 1);
      }
    }
  }

  return (
    <section className="runtime-inspector" aria-label="本地交接检查台">
      <header className="inspection-heading">
        <div>
          <div className="eyebrow">LOCAL HANDOFF INSPECTION</div>
          <h2>本地交接检查台</h2>
        </div>
        <button
          onClick={() => {
            clear();
            onClose();
          }}
        >
          关闭检查台
        </button>
      </header>
      <p className="inspection-notice">
        只检查你明确选择的本地文件，不上传、不执行、不保存。组织与模型标识仅为文件声明，来源未认证；校验通过不等于任务验收或执行授权。
      </p>
      <div className="inspection-controls">
        <label>
          交接计划 JSON（最多 256 KiB）
          <input
            key={`plan-${revision}`}
            type="file"
            accept=".json,application/json"
            disabled={started || loading}
            onChange={(e) => {
              void load(e.currentTarget.files?.[0]);
            }}
          />
        </label>
        <button onClick={clear}>清除文件与结果</button>
      </div>
      {loading && <p>正在读取本地计划…</p>}
      {error && <p role="alert">{error}</p>}
      {plan && (
        <>
          <p className="inspection-identity">
            声明的消费 Run：<code>{plan.consumer?.run_id}</code> ·{" "}
            {plan.artifacts.length} 份输入 · {plan.declared_bytes} 字节
          </p>
          <div className="inspection-columns">
            <section aria-label="生产者事件文件">
              <h3>1. 生产事件</h3>
              <p>每个清单选择一份完整 NDJSON 事件文件。</p>
              {plan.producers.map((p, i) => (
                <label className="inspection-item" key={p.manifest_id}>
                  <span>生产事件 {i + 1}</span>
                  <code>{p.manifest_id}</code>
                  <input
                    key={`${revision}-${p.manifest_id}`}
                    type="file"
                    disabled={started}
                    onChange={(e) =>
                      choose(
                        "producers",
                        p.manifest_id,
                        e.currentTarget.files?.[0],
                        4194304,
                      )
                    }
                  />
                  <small>
                    {itemStatuses[result?.producers[i]?.status ?? "idle"]}
                  </small>
                </label>
              ))}
            </section>
            <section aria-label="产物字节文件">
              <h3>2. 输入产物</h3>
              <p>按声明顺序选择原始文件；不会预览或执行内容。</p>
              {plan.artifacts.map((a, i) => (
                <label
                  className="inspection-item"
                  key={a.binding!.artifact.ref.artifact_id}
                >
                  <span>输入产物 {i + 1}</span>
                  <code>{a.binding!.artifact.ref.artifact_id}</code>
                  <input
                    key={`${revision}-${a.binding!.artifact.ref.artifact_id}`}
                    type="file"
                    disabled={started}
                    onChange={(e) =>
                      choose(
                        "artifacts",
                        a.binding!.artifact.ref.artifact_id,
                        e.currentTarget.files?.[0],
                        a.binding!.artifact.size_bytes,
                      )
                    }
                  />
                  <small>
                    {a.binding!.artifact.size_bytes} 字节 ·{" "}
                    {itemStatuses[result?.artifacts[i]?.status ?? "idle"]}
                  </small>
                </label>
              ))}
            </section>
          </div>
          <div className="inspection-controls">
            <button
              disabled={
                started ||
                selected !== plan.producers.length + plan.artifacts.length
              }
              onClick={() => {
                void inspect();
              }}
            >
              开始本地检查
            </button>
            <span>
              {started
                ? "本次检查不交付内容"
                : `${selected} / ${plan.producers.length + plan.artifacts.length} 个文件已选择`}
            </span>
          </div>
          <p
            className="inspection-result"
            aria-live="polite"
            data-testid="inspection-result"
          >
            {result ? statuses[result.status] : "未完成检查"}
          </p>
          {result?.status === "ready" && (
            <p>
              全部声明输入已核对；本检查台已释放内部内容缓冲，仅显示本次元数据。不提供执行或领取入口。
            </p>
          )}
        </>
      )}
    </section>
  );
}
