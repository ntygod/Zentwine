import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { fixture, origin, query } from "./setup.mjs";
import {
  organizationWorkbenchPath,
  ORGANIZATIONS_PATH,
} from "../../packages/contracts/dist/index.js";
const legacy = "/org/local/workbench/settings";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function browserTest(f, work) {
  const origins = [origin],
    app = f.app({ identity: { repository: f.repo, origins } });
  const calls = [];
  let beforeSwitch = null,
    browser;
  app.addHook("onRequest", async (r) => {
    if (r.url.startsWith("/api/"))
      calls.push({ path: r.url, method: r.method });
    if (r.url === "/api/v1/auth/organization" && r.method === "POST")
      await beforeSwitch?.();
  });
  for (const path of ["/org/:org/workbench", "/org/:org/workbench/:view"])
    app.get(path, async (_r, reply) =>
      reply
        .type("text/html")
        .send(await fs.readFile("apps/workbench/dist/index.html", "utf8")),
    );
  app.get("/assets/:file", async (r, reply) => {
    if (!/^index-[a-zA-Z0-9_-]+\.(js|css)$/.test(r.params.file))
      return reply.code(404).send();
    return reply
      .type(
        r.params.file.endsWith(".js") ? "application/javascript" : "text/css",
      )
      .send(await fs.readFile("apps/workbench/dist/assets/" + r.params.file));
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = "http://127.0.0.1:" + app.server.address().port;
    origins.push(base);
    browser = await chromium.launch({ headless: true });
    await fs.mkdir("reports/navigation-ui", { recursive: true });
    await work({
      browser,
      base,
      calls,
      delaySwitch: (fn) => {
        beforeSwitch = fn;
      },
    });
  } finally {
    await browser?.close();
    await app.close();
  }
}
async function login(f, browser, base, human = f.alice) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  await page.goto(base + legacy);
  await page
    .getByLabel("一次性登录票据", { exact: true })
    .fill(await f.ticket(human));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeEnabled();
  return { page, context };
}
async function enter(page, base, org) {
  await page.goto(base + organizationWorkbenchPath(org));
  await expect(page.getByLabel("切换到组织", { exact: true })).toBeVisible();
  await page.getByLabel("切换到组织", { exact: true }).selectOption(org);
  await page.getByRole("button", { name: "确认切换组织", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "组织概览", exact: true }),
  ).toBeVisible();
}
const writes = (calls) =>
  calls.filter((c) => !["GET", "HEAD"].includes(c.method));
test("navigation browser PG: canonical deep links refresh and owner governance stay read-only", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page } = await login(f, browser, base);
      calls.length = 0;
      await page.goto(base + organizationWorkbenchPath(f.orgA, "catalog"));
      await expect(page.getByText(/链接指向另一组织/)).toBeVisible();
      assert.deepEqual(writes(calls), []);
      await page
        .getByRole("button", { name: "确认切换组织", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "组织概览", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "可访问资源", exact: true }).click();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toContainText("Synthetic catalog");
      await page.reload();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toContainText("Synthetic catalog");
      await page.getByRole("link", { name: "组织治理", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "负责人治理概览" }),
      ).toBeVisible();
      await page.screenshot({
        path: "reports/navigation-ui/owner-governance.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: "reports/navigation-ui/governance-mobile.png",
        fullPage: true,
      });
      assert.equal(writes(calls).length, 1);
      assert.equal(writes(calls)[0].path, "/api/v1/auth/organization");
      assert.equal(
        await page.evaluate(
          () =>
            Object.keys(localStorage).length +
            Object.keys(sessionStorage).length,
        ),
        0,
      );
    }),
  ));
test("navigation browser PG: viewer direct governance URL and direct API are both denied", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page, context } = await login(f, browser, base);
      await enter(page, base, f.orgB);
      await expect(
        page.getByRole("link", { name: "组织治理", exact: true }),
      ).toHaveCount(0);
      calls.length = 0;
      await page.goto(base + organizationWorkbenchPath(f.orgB, "governance"));
      await expect(page.getByRole("alert")).toContainText("当前身份不能打开");
      await expect(
        page.getByRole("heading", { name: "负责人治理概览" }),
      ).toHaveCount(0);
      assert.ok(!calls.some((c) => c.path.endsWith("/settings")));
      const s = await (
        await context.request.get(base + "/api/v1/auth/session")
      ).json();
      const response = await context.request.get(
        base + `/api/v1/orgs/${f.orgB}/settings`,
        {
          headers: {
            "x-zentwine-context-version": String(s.session.context_version),
          },
        },
      );
      assert.equal(response.status(), 403);
      assert.equal((await response.json()).code, "forbidden");
    }),
  ));
test("navigation browser PG: guest directory never exposes nonshared resources or governance", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      await f.registerResource({
        display_name: "DO-NOT-LEAK-PRIVATE",
        visibility: "restricted",
      });
      await f.accept(await f.invite());
      const { page, context } = await login(f, browser, base, f.charlie);
      await enter(page, base, f.orgA);
      await page.getByRole("link", { name: "可访问资源", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "明确共享的资源" }),
      ).toBeVisible();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toContainText("Synthetic catalog");
      assert.ok(
        !(await page.textContent("body")).includes("DO-NOT-LEAK-PRIVATE"),
      );
      await expect(
        page.getByRole("link", { name: "组织治理", exact: true }),
      ).toHaveCount(0);
      const s = await (
        await context.request.get(base + "/api/v1/auth/session")
      ).json();
      const direct = await context.request.get(
        base + `/api/v1/orgs/${f.orgA}/catalog/search?q=`,
        {
          headers: {
            "x-zentwine-context-version": String(s.session.context_version),
          },
        },
      );
      assert.equal(direct.status(), 200);
      assert.ok(!(await direct.text()).includes("DO-NOT-LEAK-PRIVATE"));
      await page.screenshot({
        path: "reports/navigation-ui/guest-directory.png",
        fullPage: true,
      });
    }),
  ));
test("navigation browser PG: switch clears the old page before a delayed real command and back never switches silently", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls, delaySwitch }) => {
      const { page } = await login(f, browser, base);
      await enter(page, base, f.orgA);
      await page.getByRole("link", { name: "可访问资源", exact: true }).click();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toBeVisible();
      await page.getByLabel("资源名称", { exact: true }).fill("old query");
      const started = deferred(),
        release = deferred();
      delaySwitch(() => {
        started.resolve();
        return release.promise;
      });
      try {
        await page
          .getByLabel("切换到组织", { exact: true })
          .selectOption(f.orgB);
        await page
          .getByRole("button", { name: "确认切换组织", exact: true })
          .click();
        await started.promise;
        await expect(
          page.getByRole("list", { name: "可访问资源列表" }),
        ).toHaveCount(0);
        await expect(page.getByLabel("资源名称", { exact: true })).toHaveCount(
          0,
        );
        await expect(
          page.getByRole("navigation", { name: "组织导航" }),
        ).toHaveCount(0);
      } finally {
        release.resolve();
        delaySwitch(null);
      }
      await expect(page).toHaveURL(base + organizationWorkbenchPath(f.orgB));
      await expect(
        page.getByRole("heading", { name: "组织概览", exact: true }),
      ).toBeVisible();
      calls.length = 0;
      await page.goBack();
      await expect(page.getByText(/链接指向另一组织/)).toBeVisible();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toHaveCount(0);
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("navigation browser PG: a second window changing context is rechecked and old results disappear", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const { page, context } = await login(f, browser, base);
      await enter(page, base, f.orgA);
      await page.getByRole("link", { name: "可访问资源", exact: true }).click();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toBeVisible();
      const second = await context.newPage();
      await second.goto(base + legacy);
      await expect(
        second.getByLabel("当前组织", { exact: true }),
      ).toBeVisible();
      await second.getByLabel("当前组织", { exact: true }).selectOption(f.orgB);
      await expect(
        second.getByText("组织成员 · viewer", { exact: true }),
      ).toBeVisible();
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByText(/链接指向另一组织/)).toBeVisible();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toHaveCount(0);
    }),
  ));
test("navigation browser PG: revoke access then a new request removes all protected state", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const { page } = await login(f, browser, base);
      await enter(page, base, f.orgA);
      await page.getByRole("link", { name: "可访问资源", exact: true }).click();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toBeVisible();
      await f.organizations.revokeOrganizationSessions(
        f.reviewer.scope,
        f.alice,
      );
      await page
        .getByRole("button", { name: "搜索可访问资源", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("不可访问");
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("navigation", { name: "组织导航" }),
      ).toHaveCount(0);
    }),
  ));
test("navigation browser PG: offline and actual database read failure clear data and recover without writes", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page, context } = await login(f, browser, base);
      await enter(page, base, f.orgA);
      await page.getByRole("link", { name: "可访问资源", exact: true }).click();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toBeVisible();
      calls.length = 0;
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(
        page.getByRole("heading", { name: "离线或页面已暂停" }),
      ).toBeVisible();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toHaveCount(0);
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toBeVisible();
      await query(
        f.adminPool,
        `REVOKE SELECT ON zentwine_policy.resources FROM "${f.managerRole}"`,
      );
      await page
        .getByRole("button", { name: "搜索可访问资源", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("服务暂时不可用");
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toHaveCount(0);
      assert.ok(
        !(await page.textContent("body")).includes("permission denied"),
      );
      await query(
        f.adminPool,
        `GRANT SELECT ON zentwine_policy.resources TO "${f.managerRole}"`,
      );
      await page.getByRole("button", { name: "重新核验", exact: true }).click();
      await expect(
        page.getByRole("list", { name: "可访问资源列表" }),
      ).toBeVisible();
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("navigation browser PG: anonymous unknown and foreign deep links disclose no protected page", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const context = await browser.newContext(),
        page = await context.newPage();
      await page.goto(base + organizationWorkbenchPath(f.orgA, "governance"));
      await expect(
        page.getByRole("heading", { name: "需要登录", exact: true }),
      ).toBeVisible();
      assert.ok(
        !calls.some(
          (c) =>
            c.path.endsWith("organization-self") ||
            c.path.endsWith("/settings"),
        ),
      );
      assert.deepEqual(writes(calls), []);
      await page.goto(base + "/org/not-a-uuid/workbench");
      await expect(
        page.getByRole("heading", { name: "页面不存在" }),
      ).toBeVisible();
      const logged = await login(f, browser, base);
      await logged.page.goto(base + organizationWorkbenchPath(randomUUID()));
      await expect(logged.page.getByRole("alert")).toContainText("不可访问");
      await expect(
        logged.page.getByRole("navigation", { name: "组织导航" }),
      ).toHaveCount(0);
      await logged.page.goto(base + ORGANIZATIONS_PATH);
      await expect(
        logged.page.getByLabel("切换到组织", { exact: true }),
      ).toBeVisible();
    }),
  ));
