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
    await fs.mkdir("reports/organization-ui", { recursive: true });
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
test("org browser PG: owner edits actual persisted settings and provider config without storing secrets", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const { page } = await login(f, browser, base, f.alice);
      await page.getByLabel("当前组织", { exact: true }).selectOption(f.orgA);
      await expect(
        page.getByRole("button", { name: "保存设置" }),
      ).toBeEnabled();
      await page.getByLabel("组织名称", { exact: true }).fill("众弦协作团队");
      await page.getByRole("button", { name: "保存设置" }).click();
      await expect(
        page.getByText("组织设置已保存；旧的未接受邀请已撤销。", {
          exact: true,
        }),
      ).toBeVisible();
      assert.equal(
        (await f.organizations.settings((await f.auth()).scope)).display_name,
        "众弦协作团队",
      );
      await page
        .getByLabel("连接名称", { exact: true })
        .fill("公司身份适配端口");
      await page
        .getByLabel("精确 HTTPS Issuer", { exact: true })
        .fill("https://idp.example.test/");
      await page
        .getByLabel("Client ID", { exact: true })
        .fill("fixture-client");
      await page.getByRole("button", { name: "创建禁用配置" }).click();
      await expect(
        page.getByText("公司身份适配端口", { exact: true }),
      ).toBeVisible();
      assert.equal(
        await page.evaluate(() => Object.keys(localStorage).length),
        0,
      );
      await page.screenshot({
        path: "reports/organization-ui/owner-settings.png",
        fullPage: true,
      });
    }),
  ));
test("org browser PG: targeted guest accepts invite, sees only shares and loses access after removal", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      await f.registerResource({ display_name: "DO-NOT-SHOW-PRIVATE" });
      const inv = await f.invite();
      const { page } = await login(f, browser, base, f.charlie);
      await page
        .getByLabel("接受发给当前身份的邀请", { exact: true })
        .fill(inv.token);
      await page.getByRole("button", { name: "接受邀请", exact: true }).click();
      await expect(
        page.getByText("外部访客 · viewer", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "保存设置" })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: "搜索资源" }).click();
      await expect(
        page.getByText("Synthetic catalog", { exact: true }),
      ).toBeVisible();
      assert.ok(
        !(await page.textContent("body")).includes("DO-NOT-SHOW-PRIVATE"),
      );
      const allCookies = await page.context().cookies();
      assert.ok(
        allCookies.some(
          (c) => c.name === "zentwine_local_session" && c.httpOnly,
        ),
      );
      await page.screenshot({
        path: "reports/organization-ui/guest-shares.png",
        fullPage: true,
      });
      const member = (await f.organizations.members(f.owner.scope)).find(
        (m) => m.human_id === f.charlie,
      );
      await f.organizations.updateMember(
        f.owner.scope,
        member.id,
        "viewer",
        "revoked",
        member.object_version,
      );
      await page.getByRole("button", { name: "搜索资源" }).click();
      await expect(page.getByRole("alert")).toContainText("没有访问权限");
      await expect(
        page.getByText("Synthetic catalog", { exact: true }),
      ).toHaveCount(0);
      assert.equal(
        await page.evaluate(() => Object.keys(localStorage).length),
        0,
      );
    }),
  ));
test("org browser PG: two tabs reject stale organization context and narrow layout remains usable", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const { page, context } = await login(f, browser, base, f.alice);
      await page.getByLabel("当前组织", { exact: true }).selectOption(f.orgA);
      await expect(
        page.getByRole("button", { name: "保存设置" }),
      ).toBeEnabled();
      const second = await context.newPage();
      await second.goto(base + path);
      await expect(
        second.getByRole("button", { name: "保存设置" }),
      ).toBeEnabled();
      await second.getByLabel("当前组织", { exact: true }).selectOption(f.orgB);
      await expect(
        second.getByText("组织成员 · viewer", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "保存设置" }).click();
      await expect(page.getByRole("alert")).toContainText("版本已变化");
      await expect(page.getByRole("button", { name: "保存设置" })).toHaveCount(
        0,
      );
      await second.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await second.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      );
      await second.screenshot({
        path: "reports/organization-ui/member-mobile.png",
        fullPage: true,
      });
    }),
  ));
