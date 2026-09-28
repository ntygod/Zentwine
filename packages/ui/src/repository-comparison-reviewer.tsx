import { useEffect, useRef, useState } from "react";
import {
  createRepositoryReviewSession,
  comparisonDisplayText as display,
  REPOSITORY_COMPARISON_IMPORT_LIMITS,
  type RepositoryReviewSession,
  type ComparisonLine,
} from "@zentwine/client";

import { RepositoryReviewNotes } from "./repository-review-notes.js";

const changes = {
  added: "新增",
  deleted: "删除",
  modified: "修改",
  type_changed: "类型变化",
};
const PAGE = 50,
  ROWS = 100;

/** Standalone import viewer. No Git, HTTP, storage, code execution or approval calls. */
export function RepositoryComparisonReviewer({
  onClose,
}: {
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [session, setSession] = useState<RepositoryReviewSession | null>(null);
  const report = session?.report ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reader = useRef<FileReader | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const details = useRef<HTMLHeadingElement>(null);
  function stop() {
    generation.current++;
    reader.current?.abort();
    reader.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }
  useEffect(() => {
    heading.current?.focus();
    return () => {
      stop();
    };
  }, []);
  useEffect(() => {
    if (selected !== null) details.current?.focus();
  }, [selected]);
  function clear() {
    stop();
    setFile(null);
    setSession(null);
    setSelected(null);
    setQuery("");
    setPage(0);
    setRowPage(0);
    setLoading(false);
    setError("");
    setRevision((n) => n + 1);
  }
  function choose(value: File | undefined) {
    clear();
    if (!value) return;
    if (
      value.size < 1 ||
      value.size > REPOSITORY_COMPARISON_IMPORT_LIMITS.bytes
    ) {
      setError("报告必须为非空文件，且不超过 4 MiB。未读取内容。");
      return;
    }
    setFile(value);
  }
  function load() {
    if (!file || loading) return;
    const value = file;
    stop();
    setSession(null);
    setSelected(null);
    setError("");
    setLoading(true);
    const token = generation.current,
      current = new FileReader();
    reader.current = current;
    function finish(message = "") {
      if (token !== generation.current) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      reader.current = null;
      setLoading(false);
      setFile(null);
      setRevision((n) => n + 1);
      setError(message);
    }
    current.onerror = () =>
      finish("无法读取报告。请重新选择文件；内容不会回显。");
    current.onabort = () => finish("读取已取消。未保留报告。");
    current.onload = async () => {
      const bytes =
        current.result instanceof ArrayBuffer
          ? new Uint8Array(current.result)
          : null;
      try {
        if (token !== generation.current) return;
        if (
          !bytes ||
          bytes.byteLength !== value.size ||
          bytes.byteLength > REPOSITORY_COMPARISON_IMPORT_LIMITS.bytes
        )
          throw new Error("Invalid file size");
        const text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        const parsed = await createRepositoryReviewSession(text);
        if (token === generation.current) setSession(parsed);
        finish();
      } catch {
        finish(
          "报告格式不受支持或内容不一致。请使用 repository-compare 的成功 JSON 报告；未保留部分结果。",
        );
      } finally {
        bytes?.fill(0);
      }
    };
    timer.current = setTimeout(() => {
      if (token !== generation.current) return;
      stop();
      setLoading(false);
      setFile(null);
      setRevision((n) => n + 1);
      setError("读取超时，未保留报告。请重新选择。");
    }, 10000);
    try {
      current.readAsArrayBuffer(value);
    } catch {
      finish("无法读取报告。请重新选择文件；内容不会回显。");
    }
  }
  const filtered =
    report?.entries.filter((e) =>
      display(e.path).toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const entry = report?.entries.find((e) => e.path === selected);
  const detail = report?.selected?.path === selected ? report.selected : null;
  const rows: { hunk: number; label: string; line: ComparisonLine }[] =
    detail?.status === "text"
      ? detail.hunks.flatMap((h, i) =>
          h.lines.map((line) => ({
            hunk: i + 1,
            label: `片段 ${i + 1}：旧 ${h.old_start},${h.old_lines} / 新 ${h.new_start},${h.new_lines}`,
            line,
          })),
        )
      : [];
  return (
    <section className="comparison-reviewer" aria-label="本地代码变更审阅">
      <header className="comparison-heading">
        <div>
          <div className="eyebrow">LOCAL CHANGE REVIEW</div>
          <h2 ref={heading} tabIndex={-1}>
            本地代码变更审阅
          </h2>
        </div>
        <button
          onClick={() => {
            clear();
            onClose();
          }}
        >
          关闭变更审阅
        </button>
      </header>
      <p className="comparison-notice">
        来源未认证 ·
        仅检查报告格式，未核验原仓库。提交、对象与代码均为文件声明，不代表审查批准或执行授权。
      </p>
      <p>
        选择 CLI 导出的
        JSON，再点击导入。只在本窗口内存中查看；不上传、不自动保存、不读取目录。意见须显式下载才保存。控制与双向字符显示为
        Unicode 转义。
      </p>
      <div className="comparison-controls">
        <label>
          比较报告 JSON（最多 4 MiB）
          <input
            key={revision}
            type="file"
            accept=".json,application/json"
            onChange={(e) => choose(e.currentTarget.files?.[0])}
          />
        </label>
        <button onClick={load} disabled={!file || loading}>
          导入比较报告
        </button>
        <button onClick={clear}>清除报告与正文</button>
      </div>
      <p role="status">
        {loading
          ? "正在读取本地报告…"
          : report
            ? "报告格式已检查 · 来源仍未认证"
            : file
              ? "文件已选择，尚未读取"
              : "尚未导入报告"}
      </p>
      {loading && <button onClick={clear}>取消读取</button>}
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <dl className="comparison-identity">
            <dt>声明的基线提交</dt>
            <dd>
              <code>{report.base.commit_sha}</code>
            </dd>
            <dt>声明的目标提交</dt>
            <dd>
              <code>{report.head.commit_sha}</code>
            </dd>
          </dl>
          <p>
            直接比较两棵提交树，不自动选择共同祖先。共 {report.entries.length}{" "}
            个变更；当前磁盘、暂存区与子模块内容未检查。
          </p>
          {report.entries.length === 0 ? (
            <p>报告未声明文件变更；不代表当前工作区干净或可以合并。</p>
          ) : (
            <>
              <label>
                筛选变更路径
                <input
                  value={query}
                  maxLength={4096}
                  onChange={(e) => {
                    setQuery(e.currentTarget.value);
                    setPage(0);
                  }}
                />
              </label>
              <div className="comparison-columns">
                <section aria-label="变更文件清单">
                  <h3>
                    变更文件 <small>({filtered.length})</small>
                  </h3>
                  {!filtered.length && <p>没有匹配的变更路径。</p>}
                  <ul className="comparison-files">
                    {filtered.slice(page * PAGE, (page + 1) * PAGE).map((e) => (
                      <li key={e.path}>
                        <button
                          aria-pressed={selected === e.path}
                          onClick={() => {
                            setSelected(e.path);
                            setRowPage(0);
                          }}
                        >
                          <span>{changes[e.change]}</span>
                          <code>{display(e.path)}</code>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <nav aria-label="文件分页">
                    <button
                      disabled={page === 0}
                      onClick={() => setPage((n) => n - 1)}
                    >
                      上一页文件
                    </button>
                    <span>
                      {page + 1} /{" "}
                      {Math.max(1, Math.ceil(filtered.length / PAGE))}
                    </span>
                    <button
                      disabled={(page + 1) * PAGE >= filtered.length}
                      onClick={() => setPage((n) => n + 1)}
                    >
                      下一页文件
                    </button>
                  </nav>
                </section>
                <section
                  className="comparison-detail"
                  aria-label="选中文件差异"
                >
                  <h3 tabIndex={-1} ref={details}>
                    {entry ? display(entry.path) : "选择文件查看差异"}
                  </h3>
                  {!entry && (
                    <p>正文尚未展开。只有报告明确携带的单文件差异可供查看。</p>
                  )}
                  {entry && (
                    <>
                      <p>
                        {changes[entry.change]} · 模式{" "}
                        {entry.before?.mode ?? "不存在"} →{" "}
                        {entry.after?.mode ?? "不存在"}
                      </p>
                      <p>
                        旧对象：
                        <code>{entry.before?.object_id ?? "不存在"}</code>
                        <br />
                        新对象：
                        <code>{entry.after?.object_id ?? "不存在"}</code>
                      </p>
                      {!detail && (
                        <p>
                          此报告未携带该文件正文。请在终端对同一对提交显式指定
                          --path，再导入生成的报告；这里不会自动读取文件。
                        </p>
                      )}
                      {detail?.status === "not_rendered" && (
                        <p>
                          {detail.reason === "non_regular_object"
                            ? "符号链接或子模块对象：不渲染正文。"
                            : "二进制或非 UTF-8 文件：不渲染正文。"}
                        </p>
                      )}
                      {detail?.status === "text" && (
                        <>
                          <p>
                            声明新增 {detail.added_lines} 行，删除{" "}
                            {detail.deleted_lines}{" "}
                            行。仅显示差异片段及上下文，不是完整文件或可应用补丁。
                          </p>
                          {rows.length === 0 ? (
                            <p>没有文本差异片段（例如空文件或仅模式变化）。</p>
                          ) : (
                            <>
                              <div
                                className="comparison-table-scroll"
                                tabIndex={0}
                                role="region"
                                aria-label="逐行代码差异"
                              >
                                <table className="comparison-code">
                                  <caption>
                                    旧行 / 新行 / 操作 / 内容 · 每页最多 100 行
                                  </caption>
                                  <thead>
                                    <tr>
                                      <th>旧行</th>
                                      <th>新行</th>
                                      <th>操作</th>
                                      <th>内容</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rows
                                      .slice(
                                        rowPage * ROWS,
                                        (rowPage + 1) * ROWS,
                                      )
                                      .map(({ line, label }, i, visible) => (
                                        <tr
                                          key={rowPage * ROWS + i}
                                          data-kind={line.kind}
                                        >
                                          <td>{line.old_line ?? "—"}</td>
                                          <td>{line.new_line ?? "—"}</td>
                                          <td>
                                            {line.kind === "insert"
                                              ? "+ 新增"
                                              : line.kind === "delete"
                                                ? "− 删除"
                                                : " 上下文"}
                                          </td>
                                          <td>
                                            {(i === 0 ||
                                              visible[i - 1]?.hunk !==
                                                visible[i]?.hunk) && (
                                              <small className="comparison-hunk">
                                                {label}
                                              </small>
                                            )}
                                            <code>
                                              {display(line.text) || " "}
                                            </code>
                                            {!line.newline && (
                                              <small className="comparison-newline">
                                                〔无末尾换行〕
                                              </small>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </div>
                              <nav aria-label="差异分页">
                                <button
                                  disabled={rowPage === 0}
                                  onClick={() => setRowPage((n) => n - 1)}
                                >
                                  上一页差异
                                </button>
                                <span>
                                  {rowPage + 1} /{" "}
                                  {Math.ceil(rows.length / ROWS)}
                                </span>
                                <button
                                  disabled={(rowPage + 1) * ROWS >= rows.length}
                                  onClick={() => setRowPage((n) => n + 1)}
                                >
                                  下一页差异
                                </button>
                              </nav>
                            </>
                          )}
                        </>
                      )}
                    </>
                  )}
                </section>
              </div>
            </>
          )}
          {session && (
            <RepositoryReviewNotes
              key={session.report_sha256}
              session={session}
              selectedPath={selected}
            />
          )}
        </>
      )}
    </section>
  );
}
