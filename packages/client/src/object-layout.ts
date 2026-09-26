/** Device-local presentation only; no principal, tenant, object, text or authorization fields. */
export const OBJECT_LAYOUT_KEY = "zentwine.ui.object-layout.v1";
export interface ObjectLayout {
  readonly schema_version: 1;
  readonly density: "comfortable" | "compact";
  readonly inspector: "shown" | "hidden";
}
export const DEFAULT_OBJECT_LAYOUT: ObjectLayout = Object.freeze({
  schema_version: 1,
  density: "comfortable",
  inspector: "shown",
});
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function parseObjectLayout(raw: string): ObjectLayout {
  if (typeof raw !== "string" || raw.length > 160)
    throw new TypeError("Invalid layout");
  const v: unknown = JSON.parse(raw);
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(",") !== "density,inspector,schema_version" ||
    !("schema_version" in v && v.schema_version === 1) ||
    !(
      "density" in v &&
      (v.density === "comfortable" || v.density === "compact")
    ) ||
    !("inspector" in v && (v.inspector === "shown" || v.inspector === "hidden"))
  )
    throw new TypeError("Invalid layout");
  return Object.freeze({
    schema_version: 1,
    density: v.density,
    inspector: v.inspector,
  });
}
export function readObjectLayout(storage: () => LayoutStorage): {
  layout: ObjectLayout;
  status: "default" | "saved" | "unavailable";
} {
  try {
    const raw = storage().getItem(OBJECT_LAYOUT_KEY);
    return raw === null
      ? { layout: DEFAULT_OBJECT_LAYOUT, status: "default" }
      : { layout: parseObjectLayout(raw), status: "saved" };
  } catch {
    return { layout: DEFAULT_OBJECT_LAYOUT, status: "unavailable" };
  }
}
export function saveObjectLayout(
  storage: () => LayoutStorage,
  layout: ObjectLayout,
): boolean {
  try {
    const normalized = parseObjectLayout(JSON.stringify(layout));
    storage().setItem(OBJECT_LAYOUT_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}
export function resetObjectLayout(storage: () => LayoutStorage): boolean {
  try {
    storage().removeItem(OBJECT_LAYOUT_KEY);
    return true;
  } catch {
    return false;
  }
}
