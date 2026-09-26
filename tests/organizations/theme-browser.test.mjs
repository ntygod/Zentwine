import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { fixture, origin } from "./setup.mjs";
const path = "/org/local/workbench/settings";
test("org theme browser PG: actual owner form changes appearance without modifying settings or storage", () =>
  fixture(async (f) => {
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
      if (!/^index-[a-zA-Z0-9_-]+\.(js|css)$/.test(file))
        return reply.code(404).send();
      return reply
        .type(file.endsWith(".js") ? "application/javascript" : "text/css")
        .send(await fs.readFile("apps/workbench/dist/assets/" + file));
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const base = "http://127.0.0.1:" + app.server.address().port;
      origins.push(base);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base + path);
      await page
        .getByLabel("一次性登录票据", { exact: true })
        .fill(await f.ticket(f.alice));
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "退出登录" }),
      ).toBeEnabled();
      await page.getByLabel("当前组织", { exact: true }).selectOption(f.orgA);
      await expect(
        page.getByRole("button", { name: "保存设置" }),
      ).toBeEnabled();
      const before = await f.organizations.settings(f.owner.scope),
        writes = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/") && r.method() !== "GET")
          writes.push(r.method());
      });
      await fs.mkdir("reports/organization-ui", { recursive: true });
      for (const mode of ["light", "dark", "contrast"]) {
        await page.getByRole("combobox", { name: "外观" }).selectOption(mode);
        await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
          "data-zt-theme",
          mode,
        );
        await expect(page.getByLabel("组织名称", { exact: true })).toHaveValue(
          before.display_name,
        );
        assert.equal(
          await page
            .getByLabel("组织名称", { exact: true })
            .evaluate((el) => getComputedStyle(el).backgroundColor),
          mode === "light"
            ? "rgb(255, 255, 255)"
            : mode === "dark"
              ? "rgb(25, 30, 43)"
              : "rgb(0, 0, 0)",
        );
        await page.screenshot({
          path: `reports/organization-ui/theme-${mode}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.equal(
        await page.evaluate(
          () =>
            Object.keys(localStorage).length +
            Object.keys(sessionStorage).length,
        ),
        0,
      );
      assert.deepEqual(await f.organizations.settings(f.owner.scope), before);
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await app.close();
    }
  }));
