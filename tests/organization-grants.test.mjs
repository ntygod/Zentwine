import test from "node:test";
import assert from "node:assert/strict";
import { organizationGrantSql } from "../packages/db/dist/index.js";

test("organization grants: CONNECT targets only the current database and validated manager", () => {
  const sql = organizationGrantSql("manager", "reader");
  assert.ok(
    sql.includes(
      "format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'manager')",
    ),
  );
  assert.doesNotMatch(sql, /TO PUBLIC|GRANT ALL|GRANT CREATE|GRANT TEMP/);
});

test("organization grants: dynamic database grant cannot accept quoted role injection", () => {
  for (const manager of ["manager'", 'manager"', "manager\n", "PUBLIC"])
    assert.throws(() => organizationGrantSql(manager, "reader"));
});
