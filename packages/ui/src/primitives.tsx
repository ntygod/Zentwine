import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { UI_STATES, type UIState } from "./tokens.js";
const paths = {
  check: "m5 12 4 4L19 6",
  error: "m8 8 8 8m0-8-8 8M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18",
  clock: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  offline:
    "m3 3 18 18M4 9a13 13 0 0 1 3-2m4-1a13 13 0 0 1 9 3M7 13a8 8 0 0 1 4-2m4 1 2 1M10 17a3 3 0 0 1 4 0M12 20h.01",
  play: "m8 4 12 8-12 8V4Z",
  stop: "M6 6h12v12H6z",
  help: "M9 8a3 3 0 1 1 5 3c-1 .6-2 1-2 3m0 3h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  palette:
    "M12 3a9 9 0 1 0 0 18c3 0 1-4 4-4h2a3 3 0 0 0 3-3c0-6-4-11-9-11ZM7 9h.01M12 6h.01M17 9h.01",
} as const;
export type IconName = keyof typeof paths;
/** Decorative when paired with text; standalone callers must supply an accessible label. */
export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg
      className="zt-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true as const })}
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function StatusBadge({ state }: { state: UIState }) {
  const { label, tone, icon } = UI_STATES[state];
  return (
    <span className="zt-status" data-tone={tone} data-state={state}>
      <Icon name={icon} />
      {label}
    </span>
  );
}
export function Button({
  variant = "secondary",
  type = "button",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      {...props}
      type={type}
      className={`zt-button ${className}`}
      data-variant={variant}
    />
  );
}
export function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="zt-panel" aria-labelledby={id}>
      <header>
        <h2 id={id}>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );
}
export function TextField({
  label,
  hint,
  error,
  id: suppliedId,
  ...props
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "aria-describedby" | "aria-invalid"
> & { label: string; hint?: string; error?: string }) {
  const generatedId = useId(),
    id = suppliedId ?? generatedId;
  const describedBy =
    [hint ? id + "-hint" : "", error ? id + "-error" : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="zt-field">
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
      />
      {hint && <small id={id + "-hint"}>{hint}</small>}
      {error && (
        <p id={id + "-error"} className="zt-field-error">
          <Icon name="error" />
          {error}
        </p>
      )}
    </div>
  );
}
