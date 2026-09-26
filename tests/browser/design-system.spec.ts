import fs from "node:fs";
import { test, expect } from "./fixtures.js";
const home = "http://127.0.0.1:5173/org/local/workbench";
const gallery = home + "/design-system";
const studio = "http://127.0.0.1:5174/org/local/studio";
const modes = ["light", "dark", "contrast"];
test.beforeEach(() => {
  fs.mkdirSync("reports/screenshots", { recursive: true });
});
test("design system: three real themes display textual states and create review screenshots", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(gallery);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "让协作更清晰",
  );
  fs.mkdirSync("reports/screenshots", { recursive: true });
  for (const mode of modes) {
    await page.getByRole("combobox", { name: "外观" }).selectOption(mode);
    await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
      "data-zt-theme",
      mode,
    );
    await expect(page.locator(".zt-status")).toHaveCount(10);
    for (const name of ["运行中", "正在停止", "结果未知", "无权访问"])
      await expect(
        page.locator(".zt-status").filter({ hasText: name }),
      ).toBeVisible();
    expect(
      await page
        .locator(".zt-theme")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({
      path: `reports/screenshots/design-system-${mode}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});
test("design system: sample form and theme changes have no API calls or persistent storage", async ({
  page,
}) => {
  const apiCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) apiCalls.push(r.method());
  });
  await page.goto(gallery);
  await page.getByRole("button", { name: "检查样例输入" }).click();
  await expect(page.getByRole("textbox", { name: "样例名称" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByRole("textbox", { name: "样例名称" }),
  ).toHaveAccessibleDescription(/请填写样例名称/);
  await page
    .getByRole("textbox", { name: "样例名称" })
    .fill("团队工作区 / Team workspace");
  await page.getByRole("button", { name: "检查样例输入" }).click();
  await expect(page.getByRole("status")).toContainText("仅保留在当前页面内存");
  await page.getByRole("button", { name: "查看示例" }).click();
  await expect(page.getByRole("status")).toContainText(
    "没有保存、发送或启动执行",
  );
  await expect(
    page.getByRole("button", { name: "删除样例（不可用）" }),
  ).toBeDisabled();
  await page.getByRole("combobox", { name: "外观" }).selectOption("dark");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "外观" })).toHaveValue(
    "system",
  );
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).length + Object.keys(sessionStorage).length,
    ),
  ).toBe(0);
  expect(apiCalls).toEqual([]);
});
test("design system: native keyboard controls and skip link have visible focus", async ({
  page,
}) => {
  await page.goto(gallery);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "跳转到组件内容" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#foundation-main")).toBeFocused();
  const selector = page.getByRole("combobox", { name: "外观" });
  await selector.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(selector).toHaveValue("contrast");
  const focus = await selector.evaluate((el) => ({
    style: getComputedStyle(el).outlineStyle,
    width: getComputedStyle(el).outlineWidth,
  }));
  expect(focus.style).toBe("solid");
  expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "查看示例" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("已切换示例展示");
});
test("design system: media changes follow system only and explicit choices remain local", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(gallery);
  await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
    "data-zt-theme",
    "dark",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
    "data-zt-theme",
    "light",
  );
  await page.getByRole("combobox", { name: "外观" }).selectOption("contrast");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
    "data-zt-theme",
    "contrast",
  );
  await page.getByRole("combobox", { name: "外观" }).selectOption("system");
  await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
    "data-zt-theme",
    "dark",
  );
});
test("design system: OS forced colors retain words outlines and native adjustment", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto(gallery);
  await page.getByRole("combobox", { name: "外观" }).selectOption("contrast");
  expect(
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
  ).toBe(true);
  expect(
    await page
      .locator(".zt-status")
      .first()
      .evaluate((el) => getComputedStyle(el).forcedColorAdjust),
  ).toBe("auto");
  await expect(page.locator("[data-state='unknown']")).toHaveText("结果未知");
  expect(
    await page
      .locator("[data-state='unknown']")
      .evaluate((el) => getComputedStyle(el).borderStyle),
  ).toBe("solid");
  const selector = page.getByRole("combobox", { name: "外观" });
  await selector.focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => getComputedStyle(document.activeElement!).outlineStyle,
    ),
  ).toBe("solid");
  await page.screenshot({
    path: "reports/screenshots/design-system-forced-colors.png",
    fullPage: true,
  });
});
test("design system: 320 and 390 pixel layouts wrap long mixed-language content in every theme", async ({
  page,
}) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(gallery);
    for (const mode of modes) {
      await page.getByRole("combobox", { name: "外观" }).selectOption(mode);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      expect(
        await page
          .locator("[data-long-sample]")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
  }
  await page.screenshot({
    path: "reports/screenshots/design-system-mobile.png",
    fullPage: true,
  });
});
test("design system: doubled root text stays readable without horizontal clipping", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 1000 });
  await page.goto(gallery);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "28px";
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(640);
  await expect(page.getByRole("textbox", { name: "样例名称" })).toBeVisible();
});
test("design system: Workbench and independent Studio consume themes without business writes", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/") && r.method() !== "GET")
      writes.push(r.method());
  });
  for (const url of [home, studio]) {
    await page.goto(url);
    await expect(page.getByRole("status")).toContainText("本地 API 已连接");
    for (const mode of modes) {
      await page.getByRole("combobox", { name: "外观" }).selectOption(mode);
      await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
        "data-zt-theme",
        mode,
      );
      const foreground = await page
        .locator("h1")
        .evaluate((el) => getComputedStyle(el).color);
      expect(foreground).toBe(
        mode === "light"
          ? "rgb(32, 37, 56)"
          : mode === "dark"
            ? "rgb(237, 241, 250)"
            : "rgb(255, 255, 255)",
      );
    }
    await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  }
  expect(writes).toEqual([]);
});
