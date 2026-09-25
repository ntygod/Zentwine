import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { fixture, origin, query } from "./setup.mjs";
const path = "/org/local/workbench/settings";
async function browserTest(f, work) {
  const origins = [origin],
    app = f.app({ identity: { repository: f.repo, origins } });
  let browser;
  app.get(path, async (_r, reply) =>
    reply
      .type("text/html")
      .send(await fs.readFile("apps/workbench/dist/index.html", "utf8")),
  );
  app.get("/assets/:file", async (r, reply) => {
    const file = r.params.file;
    if (!/^index-[a-zA-Z0-9_-]+\.(js|css)$/.test(file)) {
      reply.code(404).send();
      return;
    }
    return reply
      .type(file.endsWith(".js") ? "application/javascript" : "text/css")
      .send(await fs.readFile("apps/workbench/dist/assets/" + file));
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = "http://127.0.0.1:" + app.server.address().port;
    origins.push(base);
    browser = await chromium.launch({ headless: true });
    await fs.mkdir("reports/audit-ui", { recursive: true });
    await work({ browser, base });
  } finally {
    await browser?.close();
    await app.close();
  }
}
async function login(f, browser, base, human) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    }),
    page = await context.newPage();
  await page.goto(base + path);
  await expect(
    page.getByRole("heading", { name: "本机登录", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("一次性登录票据", { exact: true })
    .fill(await f.ticket(human));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeEnabled();
  return { context, page };
}

test("audit browser PG: owner filters real records and pages a bounded snapshot on desktop and mobile", () => fixture((f) => browserTest(f, async ({ browser, base }) => {
  for (let n = 0; n < 23; n++) await f.record();
  await f.invite();
  const { page } = await login(f, browser, base, f.alice);
  await page.getByLabel("当前组织", { exact: true }).selectOption(f.orgA);
  const panel = page.getByRole("region", { name: "组织审计记录" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("审计事件类型").selectOption("settings.updated");
  await panel.getByRole("button", { name: "刷新审计记录" }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(20);
  const initialRefs = await panel.locator("li small").allTextContents();
  await panel.getByRole("button", { name: "下一页审计记录" }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(3);
  await expect(panel.getByRole("button", { name: "下一页审计记录" })).toBeDisabled();
  for (const value of await panel.locator("li small").allTextContents()) assert.ok(!initialRefs.includes(value));
  await panel.screenshot({ path: "reports/audit-ui/owner-audit.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await panel.screenshot({ path: "reports/audit-ui/audit-mobile.png" });
  await panel.getByLabel("审计事件类型").selectOption("invitation.revoked");
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  await panel.getByRole("button", { name: "刷新审计记录" }).click();
  await expect(panel.getByText("当前筛选没有已记录事件。", { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length), 0);
  assert.ok(!page.url().includes("cursor"));
})));
test("audit browser PG: stale organization tab discards displayed history and viewer has no panel", () => fixture((f) => browserTest(f, async ({ browser, base }) => {
  await f.record(); const { page, context } = await login(f, browser, base, f.alice);
  await page.getByLabel("当前组织", { exact: true }).selectOption(f.orgA);
  const panel = page.getByRole("region", { name: "组织审计记录" });
  await panel.getByRole("button", { name: "刷新审计记录" }).click(); await expect(panel.getByRole("listitem")).toHaveCount(1);
  const reference = await panel.locator("li small").textContent();
  const second = await context.newPage(); await second.goto(base + path);
  await expect(second.getByRole("region", { name: "组织审计记录" })).toBeVisible();
  await second.getByLabel("当前组织", { exact: true }).selectOption(f.orgB);
  await expect(second.getByText("组织成员 · viewer", { exact: true })).toBeVisible();
  await expect(second.getByRole("region", { name: "组织审计记录" })).toHaveCount(0);
  await panel.getByRole("button", { name: "刷新审计记录" }).click();
  await expect(page.getByRole("alert")).toContainText("版本已变化");
  await expect(page.getByRole("region", { name: "组织审计记录" })).toHaveCount(0);
  assert.ok(!(await page.textContent("body")).includes(reference));
})));
test("audit browser PG: storage failure clears old results then revocation removes audit access", () => fixture((f) => browserTest(f, async ({ browser, base }) => {
  await f.record(); const { page } = await login(f, browser, base, f.alice);
  await page.getByLabel("当前组织", { exact: true }).selectOption(f.orgA);
  const panel = page.getByRole("region", { name: "组织审计记录" });
  await panel.getByRole("button", { name: "刷新审计记录" }).click(); await expect(panel.getByRole("listitem")).toHaveCount(1);
  await query(f.adminPool, `REVOKE SELECT ON zentwine_organizations.events FROM "${f.managerRole}"`);
  await panel.getByRole("button", { name: "刷新审计记录" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时不可用"); await expect(panel.getByRole("listitem")).toHaveCount(0);
  await query(f.adminPool, `GRANT SELECT ON zentwine_organizations.events TO "${f.managerRole}"`);
  await panel.getByRole("button", { name: "刷新审计记录" }).click(); await expect(panel.getByRole("listitem")).toHaveCount(1);
  await f.organizations.revokeOrganizationSessions(f.reviewer.scope, f.alice);
  await panel.getByRole("button", { name: "刷新审计记录" }).click();
  await expect(page.getByRole("alert")).toContainText("没有访问权限");
  await expect(page.getByRole("region", { name: "组织审计记录" })).toHaveCount(0);
}))); 
