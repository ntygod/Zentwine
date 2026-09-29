import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  comparisonDisplayText as display,
  previewRepositoryReviewMerge,
  applyRepositoryReviewMerge,
  type RepositoryReviewMergePreview,
  type RepositoryReviewMergeChoice,
  parseRepositoryReviewNotes,
  serializeRepositoryReviewNotes,
  validateRepositoryReviewNotes,
  REPOSITORY_REVIEW_NOTES_LIMITS as LIMITS,
  type RepositoryReviewNote,
  type RepositoryReviewSession,
} from "@zentwine/client";

import { RepositoryReviewMergePanel } from "./repository-review-merge.js";

const kinds = { issue: "问题", suggestion: "建议", question: "疑问" };
const PAGE = 10;
function NoteComposer({
  path,
  disabled,
  add,
}: {
  path: string;
  disabled: boolean;
  add: (note: RepositoryReviewNote) => boolean;
}) {
  const [author, setAuthor] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<RepositoryReviewNote["kind"]>("question");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (add({ id: crypto.randomUUID(), path, kind, author, body })) setBody("");
  }
  return (
    <form className="review-note-composer" onSubmit={submit}>
      <p>
        当前意见目标：<code>{display(path)}</code>（文件级，不绑定某一行）
      </p>
      <label>
        自填署名（未认证）
        <input
          required
          maxLength={120}
          value={author}
          disabled={disabled}
          onChange={(e) => setAuthor(e.currentTarget.value)}
        />
      </label>
      <label>
        意见类型
        <select
          value={kind}
          disabled={disabled}
          onChange={(e) =>
            setKind(e.currentTarget.value as RepositoryReviewNote["kind"])
          }
        >
          {Object.entries(kinds).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        意见正文（最多 4000 UTF-8 字节）
        <textarea
          required
          rows={4}
          maxLength={4000}
          value={body}
          disabled={disabled}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
      </label>
      <button
        type="submit"
        disabled={disabled || !author.trim() || !body.trim()}
      >
        添加文件意见
      </button>
    </form>
  );
}

/** Local notes and explicit download. No server Review, approval or authenticated author. */
export function RepositoryReviewNotes({
  session,
  selectedPath,
}: {
  session: RepositoryReviewSession;
  selectedPath: string | null;
}) {
  const [notes, setNotes] = useState<readonly RepositoryReviewNote[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [preview, setPreview] = useState<RepositoryReviewMergePreview | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(0);
  const [composerRevision, setComposerRevision] = useState(0);
  const [download, setDownload] = useState<string | null>(null);
  const url = useRef<string | null>(null);
  const generation = useRef(0);
  const reader = useRef<FileReader | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function revoke() {
    if (url.current !== null) URL.revokeObjectURL(url.current);
    url.current = null;
  }
  function invalidateDownload() {
    revoke();
    setDownload(null);
  }
  function stop() {
    generation.current++;
    reader.current?.abort();
    reader.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }
  useEffect(
    () => () => {
      stop();
      revoke();
    },
    [],
  );
  function resetImport() {
    stop();
    setFile(null);
    setPreview(null);
    setLoading(false);
    setRevision((n) => n + 1);
  }
  function clear() {
    resetImport();
    invalidateDownload();
    setNotes([]);
    setPage(0);
    setComposerRevision((n) => n + 1);
    setError("");
    setMessage("全部意见已清除；未保存的意见无法恢复。");
  }
  function add(note: RepositoryReviewNote): boolean {
    if (loading || preview) return false;
    try {
      const next = validateRepositoryReviewNotes(session, [...notes, note]);
      // Ensure the entire set remains exportable, not just each note independently.
      serializeRepositoryReviewNotes(session, next);
      resetImport();
      invalidateDownload();
      setNotes(next);
      setPage(Math.floor((next.length - 1) / PAGE));
      setError("");
      setMessage("意见已添加到本窗口内存，尚未导出。");
      return true;
    } catch {
      setError(
        "意见无效或超出限额；署名最多 120 字节、正文最多 4000 字节、最多 100 条，整体最多 512 KiB。",
      );
      return false;
    }
  }
  function remove(id: string) {
    if (loading || preview) return;
    resetImport();
    invalidateDownload();
    setNotes(notes.filter((n) => n.id !== id));
    setPage(0);
    setError("");
    setMessage("意见已移除；请重新准备交接文件。");
  }
  function prepare() {
    if (loading || preview || !notes.length) return;
    invalidateDownload();
    try {
      const text = serializeRepositoryReviewNotes(session, notes);
      url.current = URL.createObjectURL(
        new Blob([text], { type: "application/json;charset=utf-8" }),
      );
      setDownload(url.current);
      setError("");
      setMessage(
        "交接文件已准备。只有点击下载链接才保存文件；文件可能含敏感意见。",
      );
    } catch {
      setError("无法准备意见文件；当前意见仍保留在窗口内存中。");
    }
  }
  function choose(value: File | undefined, merging = false) {
    resetImport();
    setError("");
    setMessage("");
    setMergeMode(merging);
    if (!value || (!merging && notes.length)) return;
    if (value.size < 1 || value.size > LIMITS.bytes) {
      setError("意见文件必须非空且不超过 512 KiB。未读取内容。");
      return;
    }
    setFile(value);
    setMessage("意见文件已选择，尚未读取。");
  }
  function load(merging = false) {
    if (!file || loading || mergeMode !== merging || (!merging && notes.length))
      return;
    stop();
    setPreview(null);
    if (!merging) invalidateDownload();
    setLoading(true);
    setError("");
    if (!merging) setComposerRevision((n) => n + 1);
    setMessage("正在读取意见文件…");
    const value = file,
      token = generation.current,
      current = new FileReader();
    reader.current = current;
    function finish(message: string, failed = false) {
      if (token !== generation.current) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      reader.current = null;
      setLoading(false);
      setFile(null);
      setRevision((n) => n + 1);
      setMessage(failed ? "" : message);
      setError(failed ? message : "");
    }
    current.onerror = () => finish("无法读取意见文件；未导入任何意见。", true);
    current.onabort = () => finish("意见读取已取消。");
    current.onload = () => {
      const bytes =
        current.result instanceof ArrayBuffer
          ? new Uint8Array(current.result)
          : null;
      try {
        if (token !== generation.current) return;
        if (
          !bytes ||
          bytes.byteLength !== value.size ||
          bytes.byteLength > LIMITS.bytes
        )
          throw new Error("size");
        const text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        if (merging) {
          setPreview(previewRepositoryReviewMerge(session, notes, text));
          finish("合并预览已准备；当前意见未改变，请检查后明确确认。");
        } else {
          const next = parseRepositoryReviewNotes(session, text);
          setNotes(next);
          setPage(0);
          finish("意见已导入；内容绑定一致，来源和署名仍未认证。");
        }
      } catch {
        finish(
          merging
            ? "合并文件无效、绑定不匹配或合并条数超限；当前意见未改变。"
            : "意见文件无效、超限或不属于这份原报告；未导入任何意见。",
          true,
        );
      } finally {
        bytes?.fill(0);
      }
    };
    timer.current = setTimeout(() => {
      if (token !== generation.current) return;
      resetImport();
      setMessage("");
      setError("意见读取超时；未导入任何意见。");
    }, 10000);
    try {
      current.readAsArrayBuffer(value);
    } catch {
      finish("无法读取意见文件；未导入任何意见。", true);
    }
  }
  function confirmMerge(choices: readonly RepositoryReviewMergeChoice[]) {
    if (!preview || loading) return;
    try {
      const next = applyRepositoryReviewMerge(session, preview, notes, choices);
      resetImport();
      invalidateDownload();
      setNotes(next);
      setPage(0);
      setComposerRevision((n) => n + 1);
      setError("");
      setMessage("意见已合并到本窗口内存；来源仍未认证，请重新准备交接文件。");
    } catch {
      setError(
        "合并无法应用：预览已失效、冲突未完整选择或整体超过 512 KiB；当前意见未改变。",
      );
    }
  }
  return (
    <section className="repository-review-notes" aria-label="文件审阅意见交接">
      <h3>文件审阅意见交接</h3>
      <p>
        意见和署名均未认证，不是审查批准或 Agent
        指令。仅保留在本窗口内存中；关闭、刷新、替换或清除比较报告会丢失未导出的意见。切换文件会清空未添加草稿，已添加意见保留。
      </p>
      <p>
        原报告字节 SHA-256：<code>{session.report_sha256}</code>
        。接收者需要同一原报告；重新格式化 JSON 也会改变绑定。
      </p>
      {selectedPath ? (
        <NoteComposer
          key={`${composerRevision}:${selectedPath}`}
          path={selectedPath}
          disabled={loading || !!preview || notes.length >= LIMITS.notes}
          add={add}
        />
      ) : (
        <p>先从变更清单选择一个文件，再添加文件级意见。</p>
      )}
      <h4>
        当前意见集（{notes.length} / {LIMITS.notes}）
      </h4>
      <ol className="review-notes-list" start={page * PAGE + 1}>
        {notes.slice(page * PAGE, (page + 1) * PAGE).map((note, i) => (
          <li key={note.id}>
            <p>
              <strong>{kinds[note.kind]}</strong> ·{" "}
              <code>{display(note.path)}</code> · 自填署名：
              {display(note.author)}（未认证）
            </p>
            <p className="review-note-body">{display(note.body)}</p>
            <button
              onClick={() => remove(note.id)}
              disabled={loading || !!preview}
              aria-label={`移除意见 ${page * PAGE + i + 1}`}
            >
              移除意见
            </button>
          </li>
        ))}
      </ol>
      {notes.length > PAGE && (
        <nav aria-label="意见分页">
          <button disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
            上一页意见
          </button>
          <span>
            {page + 1} / {Math.ceil(notes.length / PAGE)}
          </span>
          <button
            disabled={(page + 1) * PAGE >= notes.length}
            onClick={() => setPage((n) => n + 1)}
          >
            下一页意见
          </button>
        </nav>
      )}
      <div className="comparison-controls">
        <button
          onClick={prepare}
          disabled={loading || !!preview || !notes.length}
        >
          准备意见交接文件
        </button>
        <button onClick={clear}>清除全部意见</button>
        {download && (
          <a href={download} download="zentwine-review-notes.json">
            下载审阅意见 JSON
          </a>
        )}
      </div>
      <p>
        文件只包含绑定元数据与意见，不自动附带代码正文；意见中主动引用的代码也会导出。已有意见时禁止导入覆盖，请先下载再清除。原比较报告需要另行交接。未添加草稿不进入下载；导入意见会清空未添加草稿。
      </p>
      <div className="comparison-controls">
        <label>
          意见交接 JSON（最多 512 KiB）
          <input
            key={revision}
            type="file"
            accept=".json,application/json"
            disabled={!!notes.length || loading}
            onChange={(e) => choose(e.currentTarget.files?.[0])}
          />
        </label>
        <button
          onClick={() => load(false)}
          disabled={!file || loading || mergeMode || !!notes.length}
        >
          导入文件意见
        </button>
        {loading && (
          <button
            onClick={() => {
              resetImport();
              setMessage("意见读取已取消。");
            }}
          >
            取消意见读取
          </button>
        )}
      </div>
      {session.report.entries.length > 0 ? (
        <>
          <h4>合并另一份意见</h4>
          <p>
            逐份选择同一原报告的意见文件，预览新增、重复与冲突后确认。预览、取消或失败不更改当前意见和已准备的下载；确认成功会清空未添加草稿并使旧下载失效。
          </p>
          <div className="comparison-controls">
            <label>
              待合并意见 JSON（最多 512 KiB）
              <input
                key={`merge:${revision}`}
                type="file"
                accept=".json,application/json"
                onChange={(e) => choose(e.currentTarget.files?.[0], true)}
              />
            </label>
            <button
              onClick={() => load(true)}
              disabled={!file || !mergeMode || loading}
            >
              预览意见合并
            </button>
          </div>
          {preview && (
            <RepositoryReviewMergePanel
              preview={preview}
              confirm={confirmMerge}
              cancel={() => {
                resetImport();
                setError("");
                setMessage("合并预览已取消；当前意见未改变。");
              }}
            />
          )}
        </>
      ) : (
        <p>原报告没有变更文件，无可汇总的文件意见。</p>
      )}
      <p aria-live="polite">{message}</p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
