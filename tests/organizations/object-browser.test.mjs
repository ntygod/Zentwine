import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { fixture, origin, query } from "./setup.mjs";
import { resourceObjectPath } from "../../packages/contracts/dist/index.js";
import { OBJECT_LAYOUT_KEY } from "../../packages/client/dist/object-layout.js";
const legacy = "/org/local/workbench/settings";
async function browserTest(f, work) {
  const origins = [origin],
    app = f.app({ identity: { repository: f.repo, origins } }),
    calls = [];
  let browser;
  app.addHook("onRequest", async (r) => {
    if (r.url.startsWith("/api/"))
      calls.push({ path: r.url, method: r.method });
  });
  for (const path of [
    "/org/:org/workbench",
    "/org/:org/workbench/:view",
    "/org/:org/workbench/objects/:id",
  ])
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
    await fs.mkdir("reports/object-ui", { recursive: true });
    await work({ browser, base, calls });
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
async function open(f, page, base, id = f.a.id) {
  await page.goto(base + resourceObjectPath(f.orgA, id));
  const confirm = page.getByRole("button", {
    name: "确认切换组织",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(
    page.getByRole("heading", { name: "资源详情", exact: true }),
  ).toBeVisible();
}
const formal = (page) =>
  page.getByRole("region", { name: "正式记录", exact: true });
const writes = (calls) =>
  calls.filter((c) => !["GET", "HEAD"].includes(c.method));
test("object browser PG: deep link and directory read exact resource without writes or fake history", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      calls.length = 0;
      await expect(formal(page)).toContainText(f.a.id);
      await expect(formal(page)).toContainText(f.orgA);
      await expect(
        page.getByRole("complementary", { name: "版本、证据与活动" }),
      ).toContainText("版本历史尚未接通");
      await expect(
        page.getByRole("region", { name: "协作对话" }),
      ).toContainText("对话服务尚未接通");
      await page.getByRole("link", { name: "可访问资源", exact: true }).click();
      await page
        .getByRole("list", { name: "可访问资源列表" })
        .getByRole("link", { name: f.a.display_name, exact: true })
        .click();
      await expect(page).toHaveURL(base + resourceObjectPath(f.orgA, f.a.id));
      await expect(formal(page)).toBeVisible();
      await page.reload();
      await expect(formal(page)).toBeVisible();
      assert.deepEqual(writes(calls), []);
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
      await page.screenshot({
        path: "reports/object-ui/resource-light.png",
        fullPage: true,
      });
    }),
  ));
test("object browser PG: native read-decision drawer traps focus and returns it on Escape", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      calls.length = 0;
      const trigger = page.getByRole("button", {
        name: "查看读取判定",
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
          name: "读取判定 · 非批准",
          exact: true,
        }),
        close = dialog.getByRole("button", { name: "关闭判定详情" });
      await expect(dialog).toBeVisible();
      await expect(close).toBeFocused();
      await expect(dialog).toContainText(f.a.id);
      await expect(dialog).toContainText(f.alice);
      await expect(dialog).toContainText("resource.read");
      for (const key of ["Tab", "Shift+Tab", "Tab"]) {
        await page.keyboard.press(key);
        assert.equal(
          await page.evaluate(
            () =>
              !!document
                .querySelector("dialog")
                ?.contains(document.activeElement),
          ),
          true,
        );
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await close.click();
      await expect(trigger).toBeFocused();
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("object browser PG: explicit layout save restores enums across reload and reset preserves other keys", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      calls.length = 0;
      await page
        .getByLabel("阅读密度", { exact: true })
        .selectOption("compact");
      await page
        .getByLabel("显示版本、证据与活动侧栏", { exact: true })
        .uncheck();
      assert.equal(await page.evaluate(() => localStorage.length), 0);
      await page.getByRole("button", { name: "记住布局", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("布局已保存");
      const stored = await page.evaluate(() =>
        Object.fromEntries(Object.entries(localStorage)),
      );
      assert.deepEqual(stored, {
        [OBJECT_LAYOUT_KEY]: JSON.stringify({
          schema_version: 1,
          density: "compact",
          inspector: "hidden",
        }),
      });
      await page.reload();
      await expect(formal(page)).toBeVisible();
      await expect(page.getByLabel("阅读密度", { exact: true })).toHaveValue(
        "compact",
      );
      await expect(
        page.getByRole("complementary", { name: "版本、证据与活动" }),
      ).toHaveCount(0);
      await page.evaluate(() =>
        localStorage.setItem("unrelated-ui-fixture", "keep"),
      );
      await page.getByRole("button", { name: "重置布局", exact: true }).click();
      await expect(page.getByLabel("阅读密度", { exact: true })).toHaveValue(
        "comfortable",
      );
      assert.deepEqual(
        await page.evaluate(() =>
          Object.fromEntries(Object.entries(localStorage)),
        ),
        { "unrelated-ui-fixture": "keep" },
      );
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("object browser PG: guest reads shared object but direct restricted and cross-org IDs stay unavailable", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const hidden = await f.registerResource({
        display_name: "HIDDEN-OBJECT-MARKER",
        visibility: "restricted",
      });
      await f.accept(await f.invite());
      const { page, context } = await login(f, browser, base, f.charlie);
      await open(f, page, base);
      await expect(formal(page)).toBeVisible();
      calls.length = 0;
      for (const id of [hidden.id, f.b.id, randomUUID()]) {
        await page.goto(base + resourceObjectPath(f.orgA, id));
        await expect(page.getByRole("alert")).toBeVisible();
        await expect(formal(page)).toHaveCount(0);
        assert.ok(
          !(await page.textContent("body")).includes("HIDDEN-OBJECT-MARKER"),
        );
        const auth = await (
          await context.request.get(base + "/api/v1/auth/session")
        ).json();
        const response = await context.request.get(
          base + `/api/v1/orgs/${f.orgA}/resources/${id}`,
          {
            headers: {
              "x-zentwine-context-version": String(
                auth.session.context_version,
              ),
            },
          },
        );
        assert.equal(response.status(), 404);
        assert.ok(!(await response.text()).includes("HIDDEN-OBJECT-MARKER"));
      }
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("object browser PG: revocation and revalidation remove object and an open drawer", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      await page
        .getByRole("button", { name: "查看读取判定", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await f.organizations.revokeOrganizationSessions(
        f.reviewer.scope,
        f.alice,
      );
      calls.length = 0;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(formal(page)).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      assert.ok(!(await page.textContent("body")).includes(f.a.id));
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("object browser PG: offline and real resource read failure clear old data then recover", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page, context } = await login(f, browser, base);
      await open(f, page, base);
      calls.length = 0;
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(formal(page)).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "离线或页面已暂停" }),
      ).toBeVisible();
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(formal(page)).toBeVisible();
      await query(
        f.adminPool,
        `REVOKE SELECT ON zentwine_policy.resources FROM "${f.appConfig.user}"`,
      );
      await page.getByRole("button", { name: "重新核验", exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(formal(page)).toHaveCount(0);
      assert.ok(
        !(await page.textContent("body")).includes("permission denied"),
      );
      await query(
        f.adminPool,
        `GRANT SELECT ON zentwine_policy.resources TO "${f.appConfig.user}"`,
      );
      await page.getByRole("button", { name: "重新核验", exact: true }).click();
      await expect(formal(page)).toBeVisible();
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("object browser PG: poisoned and unavailable layout storage do not inject content or prevent reads", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page, context } = await login(f, browser, base);
      await page.evaluate(
        (key) =>
          localStorage.setItem(
            key,
            JSON.stringify({
              schema_version: 1,
              density: "compact",
              inspector: "hidden",
              raw: "PRIVATE-LAYOUT-MARKER",
            }),
          ),
        OBJECT_LAYOUT_KEY,
      );
      await open(f, page, base);
      await expect(page.getByRole("status")).toContainText("使用默认布局");
      assert.ok(
        !(await page.textContent("body")).includes("PRIVATE-LAYOUT-MARKER"),
      );
      await context.addInitScript(() =>
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException("blocked", "SecurityError");
          },
        }),
      );
      calls.length = 0;
      await page.reload();
      await expect(formal(page)).toBeVisible();
      await page.getByRole("button", { name: "记住布局", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("浏览器存储不可用");
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("object browser PG: three themes mobile zoom and forced colors keep records and drawer readable", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      calls.length = 0;
      for (const theme of ["dark", "contrast"]) {
        await page.getByRole("combobox", { name: "外观" }).selectOption(theme);
        await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
          "data-zt-theme",
          theme,
        );
        assert.equal(
          await formal(page).evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          ),
          theme === "dark" ? "rgb(25, 30, 43)" : "rgb(0, 0, 0)",
        );
        await expect(formal(page)).toBeVisible();
        await page.screenshot({
          path: `reports/object-ui/resource-${theme}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: "reports/object-ui/resource-mobile.png",
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "查看读取判定", exact: true })
        .click();
      await page.screenshot({
        path: "reports/object-ui/decision-mobile.png",
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 320, height: 844 });
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "28px"),
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.emulateMedia({ forcedColors: "active" });
      await expect(formal(page)).toBeVisible();
      assert.deepEqual(writes(calls), []);
    }),
  ));
test("object browser PG: another window changing organization invalidates detail without automatic return command", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page, context } = await login(f, browser, base);
      await open(f, page, base);
      const second = await context.newPage();
      await second.goto(base + legacy);
      await expect(
        second.getByLabel("当前组织", { exact: true }),
      ).toBeVisible();
      await second.getByLabel("当前组织", { exact: true }).selectOption(f.orgB);
      await expect(
        second.getByText("组织成员 · viewer", { exact: true }),
      ).toBeVisible();
      calls.length = 0;
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByText(/链接指向另一组织/)).toBeVisible();
      await expect(formal(page)).toHaveCount(0);
      assert.deepEqual(writes(calls), []);
    }),
  ));
