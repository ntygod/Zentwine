import { useState } from "react";
import {
  comparisonDisplayText as display,
  type RepositoryReviewMergeChoice,
  type RepositoryReviewMergePreview,
  type RepositoryReviewNote,
} from "@zentwine/client";

const PAGE = 10;
const kinds = { issue: "问题", suggestion: "建议", question: "疑问" };
function Note({ note }: { note: RepositoryReviewNote }) {
  return (
    <div>
      <p>
        <code>{display(note.path)}</code> · {kinds[note.kind]} · 自填署名：
        {display(note.author)}（未认证）
      </p>
      <p className="review-note-body">{display(note.body)}</p>
    </div>
  );
}

/** Presentation only: reads/commit live in the existing notes controller. */
export function RepositoryReviewMergePanel({
  preview,
  confirm,
  cancel,
}: {
  preview: RepositoryReviewMergePreview;
  confirm: (choices: readonly RepositoryReviewMergeChoice[]) => void;
  cancel: () => void;
}) {
  const [choices, setChoices] = useState<
    ReadonlyMap<string, RepositoryReviewMergeChoice["keep"]>
  >(new Map());
  const [page, setPage] = useState(0);
  const conflicts = new Map(preview.conflicts.map((item) => [item.id, item]));
  const duplicateIds = new Set(preview.duplicates);
  const remaining = preview.conflicts.length - choices.size;
  return (
    <section className="review-merge-preview" aria-label="合并预览">
      <h4>合并预览 · 尚未应用</h4>
      <p>
        当前 {preview.current.length} 条；导入 {preview.incoming.length}{" "}
        条；新增 {preview.additions.length} 条；相同 ID 完全重复{" "}
        {preview.duplicates.length} 条；冲突 {preview.conflicts.length}{" "}
        条。确认后共 {preview.total} 条。
      </p>
      <p>
        仅按 ID 和全部字段精确去重，不推断语义或作者身份。不同 ID
        的相似意见会保留；冲突必须逐条选择，当前意见在确认前不变。
      </p>
      {!preview.incoming.length && (
        <p>导入文件没有意见，确认不会删除当前意见。</p>
      )}
      <ol className="review-notes-list" start={page * PAGE + 1}>
        {preview.incoming.slice(page * PAGE, (page + 1) * PAGE).map((note) => {
          const conflict = conflicts.get(note.id);
          return (
            <li key={note.id}>
              <p>
                <strong>
                  {conflict
                    ? "冲突"
                    : duplicateIds.has(note.id)
                      ? "重复（将去重）"
                      : "新增"}
                </strong>{" "}
                · ID：<code>{note.id}</code>
              </p>
              {conflict ? (
                <>
                  <div className="review-merge-sides">
                    <div>
                      <h5>当前版本</h5>
                      <Note note={conflict.current} />
                    </div>
                    <div>
                      <h5>导入版本</h5>
                      <Note note={conflict.incoming} />
                    </div>
                  </div>
                  <label>
                    冲突处理 {note.id}
                    <select
                      aria-label={`冲突处理 ${note.id}`}
                      value={choices.get(note.id) ?? ""}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setChoices((before) => {
                          const next = new Map(before);
                          if (value === "current" || value === "incoming")
                            next.set(note.id, value);
                          else next.delete(note.id);
                          return next;
                        });
                      }}
                    >
                      <option value="">请选择，不默认覆盖</option>
                      <option value="current">保留当前意见</option>
                      <option value="incoming">采用导入意见</option>
                    </select>
                  </label>
                </>
              ) : (
                <Note note={note} />
              )}
            </li>
          );
        })}
      </ol>
      {preview.incoming.length > PAGE && (
        <nav aria-label="合并预览分页">
          <button disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
            上一页预览
          </button>
          <span>
            {page + 1} / {Math.ceil(preview.incoming.length / PAGE)}
          </span>
          <button
            disabled={(page + 1) * PAGE >= preview.incoming.length}
            onClick={() => setPage((n) => n + 1)}
          >
            下一页预览
          </button>
        </nav>
      )}
      <p aria-live="polite">
        尚有 {remaining} 条冲突未选择。确认只更新本窗口意见，不批准或合并代码。
      </p>
      <div className="comparison-controls">
        <button
          disabled={remaining !== 0}
          onClick={() =>
            confirm(Array.from(choices, ([id, keep]) => ({ id, keep })))
          }
        >
          确认合并意见
        </button>
        <button onClick={cancel}>取消合并预览</button>
      </div>
    </section>
  );
}
