import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  fixture as auditFixture,
  query,
  request,
  origin,
  waitForDatabaseLock,
} from "../audit/setup.mjs";
import { organizationGrantSql } from "../../packages/db/dist/index.js";
export { query, request, origin, waitForDatabaseLock };
export const fails = (code) => (e) => e.code === code;
export const migration = (part) =>
  fs.readFile(
    `packages/db/migrations/0007-emergency-containment.${part}.sql`,
    "utf8",
  );
export const path = (f, mid) =>
  `/api/v1/orgs/${f.orgA}/members/${mid}/emergency-access`;
export async function fixture(work) {
  return auditFixture(async (f) => {
    await query(f.adminPool, await migration("up"));
    await query(
      f.adminPool,
      organizationGrantSql(f.managerRole, f.appConfig.user),
    );
    const members = await f.organizations.members(f.owner.scope);
    const aliceMember = members.find((m) => m.human_id === f.alice);
    const bobMember = members.find((m) => m.human_id === f.bob);
    const state = (mid = bobMember.id, scope = f.owner.scope) =>
      f.organizations.emergencyState(scope, mid);
    const command = async (
      mid = bobMember.id,
      scope = f.owner.scope,
      action = "hold",
    ) => {
      const s = await state(mid, scope);
      return {
        request_id: randomUUID(),
        action,
        reason:
          action === "hold" ? "suspected_compromise" : "incident_contained",
        confirm_human_id: s.human_id,
        expected_version: s.version,
        expected_member_version: s.member_version,
      };
    };
    const change = async (
      mid = bobMember.id,
      scope = f.owner.scope,
      action = "hold",
    ) =>
      f.organizations.emergencyChange(
        scope,
        mid,
        await command(mid, scope, action),
      );
    return work({ ...f, aliceMember, bobMember, state, command, change });
  });
}
