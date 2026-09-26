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
    await fs.mkdir("reports/emergency-ui", { recursive: true });
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

const panelFor = (page) =>
  page.getByRole("region", { name: "成员应急访问控制" });
async function selectTarget(page, f) {
  await page.getByLabel("当前组织", { exact: true }).selectOption(f.orgA);
  const panel = panelFor(page);
  await expect(panel).toBeVisible();
  await panel.getByLabel("应急目标成员").selectOption(f.bobMember.id);
  await panel.getByRole("button", { name: "检查应急状态" }).click();
  await expect(panel.getByText(/当前状态：未应急阻断/)).toBeVisible();
  return panel;
}
test("emergency browser PG: owner explicitly contains and releases another member with fresh-login recovery", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const { page } = await login(f, browser, base, f.alice);
      const panel = await selectTarget(page, f);
      const submit = panel.getByRole("button", {
        name: "确认应急阻断",
        exact: true,
      });
      await expect(submit).toBeDisabled();
      await panel.getByLabel("输入目标身份编号确认").fill(f.bob);
      await submit.click();
      await expect(panel.getByText(/当前状态：应急阻断中/)).toBeVisible();
      await expect(
        panel.getByText("应急操作已提交", { exact: true }),
      ).toBeVisible();
      assert.equal((await f.state()).held, true);
      await assert.rejects(f.policy.readResource(f.reviewer.scope, f.a.id));
      await panel.screenshot({
        path: "reports/emergency-ui/owner-containment.png",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await panel.screenshot({
        path: "reports/emergency-ui/containment-mobile.png",
      });
      await panel.getByLabel("输入目标身份编号确认").fill(f.bob);
      await panel
        .getByRole("button", { name: "确认解除应急阻断", exact: true })
        .click();
      await expect(panel.getByText(/当前状态：未应急阻断/)).toBeVisible();
      await assert.rejects(f.policy.readResource(f.reviewer.scope, f.a.id));
      const fresh = await f.auth(f.bob);
      assert.equal(
        (await f.policy.readResource(fresh.scope, f.a.id)).resource.id,
        f.a.id,
      );
      assert.equal(
        await page.evaluate(
          () =>
            Object.keys(localStorage).length +
            Object.keys(sessionStorage).length,
        ),
        0,
      );
      const audit = page.getByRole("region", { name: "组织审计记录" });
      await audit
        .getByLabel("审计事件类型")
        .selectOption("member.emergency_held");
      await audit.getByRole("button", { name: "刷新审计记录" }).click();
      const entry = audit.getByRole("listitem");
      await expect(entry).toHaveCount(1);
      await expect(
        entry.getByText("成员已应急阻断", { exact: true }),
      ).toBeVisible();
      await expect(
        entry.getByText(f.bobMember.id, { exact: true }),
      ).toBeVisible();
      await expect(entry.getByText(f.alice, { exact: true })).toBeVisible();
    }),
  ));
test("emergency browser PG: stale organization tab cannot execute and viewer has no control", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const { page, context } = await login(f, browser, base, f.alice);
      const panel = await selectTarget(page, f);
      await panel.getByLabel("输入目标身份编号确认").fill(f.bob);
      const other = await context.newPage();
      await other.goto(base + path);
      await expect(panelFor(other)).toBeVisible();
      await other.getByLabel("当前组织", { exact: true }).selectOption(f.orgB);
      await expect(panelFor(other)).toHaveCount(0);
      await panel
        .getByRole("button", { name: "确认应急阻断", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("版本已变化");
      await expect(panelFor(page)).toHaveCount(0);
      assert.equal((await f.state()).held, false);
    }),
  ));
test("emergency browser PG: database failure clears state and explicit same-request retry commits once", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const { page } = await login(f, browser, base, f.alice);
      const panel = await selectTarget(page, f);
      await query(
        f.adminPool,
        `REVOKE INSERT ON zentwine_organizations.emergency_receipts FROM "${f.managerRole}"`,
      );
      await panel.getByLabel("输入目标身份编号确认").fill(f.bob);
      await panel
        .getByRole("button", { name: "确认应急阻断", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("暂时不可用");
      await expect(panel.getByText(/当前状态：/)).toHaveCount(0);
      assert.equal((await f.state()).held, false);
      await query(
        f.adminPool,
        `GRANT INSERT ON zentwine_organizations.emergency_receipts TO "${f.managerRole}"`,
      );
      await panel.getByRole("button", { name: "重试同一应急请求" }).click();
      await expect(panel.getByText(/当前状态：应急阻断中/)).toBeVisible();
      assert.equal((await f.state()).version, 1);
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT * FROM zentwine_organizations.emergency_receipts",
          )
        ).rows.length,
        1,
      );
    }),
  ));
