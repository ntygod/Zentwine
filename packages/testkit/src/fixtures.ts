/** Synthetic business data, never an authenticated production principal. */
export interface TenantFixture {
  readonly fixture_only: true;
  readonly scope: string;
  readonly org_id: string;
  readonly owner_id: string;
  readonly reader_id: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly context_snapshot_id: string;
  readonly spec: {
    readonly id: string;
    readonly revision: number;
    readonly content_hash: string;
  };
}
export function fixtureId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^fixture_[a-z0-9_]{1,100}$/.test(value))
    throw new TypeError("Invalid synthetic identifier");
}
export function createTenantFixtures(
  scope: string,
): readonly [TenantFixture, TenantFixture] {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(scope))
    throw new TypeError("Invalid fixture scope");
  const make = (suffix: string): TenantFixture => {
    const prefix = `fixture_${scope}_${suffix}`;
    return Object.freeze({
      fixture_only: true,
      scope,
      org_id: `${prefix}_org`,
      owner_id: `${prefix}_owner`,
      reader_id: `${prefix}_reader`,
      task_id: `${prefix}_task`,
      workspace_id: `${prefix}_workspace`,
      context_snapshot_id: `${prefix}_context`,
      spec: Object.freeze({
        id: `${prefix}_spec`,
        revision: 1,
        content_hash: suffix === "a" ? "a".repeat(64) : "b".repeat(64),
      }),
    });
  };
  return Object.freeze([make("a"), make("b")] as const);
}
/** Test-double policy only. The future identity module must not import this. */
export function fixtureAllows(
  tenant: TenantFixture,
  actor: string,
  org: string,
  action: "read" | "write",
): boolean {
  return (
    ["read", "write"].includes(action) &&
    tenant.fixture_only === true &&
    org === tenant.org_id &&
    (actor === tenant.owner_id ||
      (action === "read" && actor === tenant.reader_id))
  );
}
