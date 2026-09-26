import { useEffect, useRef, useState, type ReactNode } from "react";
/** Slots keep official records separate from discussion and from auxiliary evidence. */
export function ObjectPageFrame({
  title,
  summary,
  controls,
  formal,
  discussion,
  inspector,
  density,
  showInspector,
}: {
  title: string;
  summary: ReactNode;
  controls: ReactNode;
  formal: ReactNode;
  discussion: ReactNode;
  inspector: ReactNode;
  density: "comfortable" | "compact";
  showInspector: boolean;
}) {
  return (
    <article className="zt-object" data-density={density}>
      <header className="zt-object-header">
        <div className="eyebrow">OBJECT · VERIFIED READ</div>
        <h2>{title}</h2>
        {summary}
      </header>
      <section className="zt-object-controls" aria-label="对象页布局">
        {controls}
      </section>
      <div
        className="zt-object-columns"
        data-inspector={showInspector ? "shown" : "hidden"}
      >
        <div className="zt-object-primary">
          <section className="card zt-object-section" aria-label="正式记录">
            <h3>正式记录</h3>
            {formal}
          </section>
          <section className="card zt-object-section" aria-label="协作对话">
            <h3>协作对话</h3>
            {discussion}
          </section>
        </div>
        {showInspector && (
          <aside
            className="card zt-object-section"
            aria-label="版本、证据与活动"
          >
            {inspector}
          </aside>
        )}
      </div>
    </article>
  );
}
/** Native modal makes the background inert; explicit boundary cycling retains Tab focus. */
export function DecisionDrawer({
  title,
  trigger,
  children,
}: {
  title: string;
  trigger: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false),
    dialog = useRef<HTMLDialogElement>(null),
    close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current,
      previous = document.activeElement;
    element.showModal();
    close.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [open]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {trigger}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="zt-decision-drawer"
          aria-label={title}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== "Tab" || e.nativeEvent.isComposing) return;
            const element = e.currentTarget;
            const controls = Array.from(
              element.querySelectorAll<HTMLElement>(
                "button, [href], input, select, textarea, [tabindex]",
              ),
            ).filter(
              (control) =>
                control.tabIndex >= 0 &&
                !control.matches(":disabled") &&
                !control.closest("[inert]") &&
                control.getClientRects().length > 0,
            );
            const first = controls[0],
              last = controls.at(-1);
            if (!first || !last) {
              e.preventDefault();
              element.focus();
            } else if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }}
          onCancel={(e) => {
            e.preventDefault();
            setOpen(false);
          }}
        >
          <header>
            <h2>{title}</h2>
            <button ref={close} type="button" onClick={() => setOpen(false)}>
              关闭判定详情
            </button>
          </header>
          {children}
        </dialog>
      )}
    </>
  );
}
