import { test, expect } from "./fixtures.js";
import fs from "node:fs";
const workbench = "http://127.0.0.1:5173/org/local/workbench";
const studio = "http://127.0.0.1:5174/org/local/studio";
test("management opens independent Studio; navigation and refresh only read", async ({
  page,
  context,
}) => {
  const writes: string[] = [];
  context.on("request", (r) => {
    if (r.url().includes("/api/") && r.method() !== "GET")
      writes.push(`${r.method()} ${r.url()}`);
  });
  await page.goto(workbench);
  await expect(
    page.getByRole("heading", { name: "团队的下一次协作，从这里开始。" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("本地 API 已连接");
  fs.mkdirSync("reports/screenshots", { recursive: true });
  await page.screenshot({
    path: "reports/screenshots/workbench.png",
    fullPage: true,
  });
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("link", { name: "打开独立 Studio" }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(studio);
  await expect(
    popup.getByRole("heading", { name: "独立开发，不脱离团队。" }),
  ).toBeVisible();
  await expect(popup.getByRole("status")).toContainText("本地 API 已连接");
  await popup.reload();
  await expect(popup.getByRole("status")).toContainText("本地 API 已连接");
  await popup.screenshot({
    path: "reports/screenshots/studio.png",
    fullPage: true,
  });
  expect(writes).toEqual([]);
  await popup.close();
  await expect(page.getByRole("status")).toContainText("本地 API 已连接");
});
test("Studio can be entered directly and unknown workspace stays unavailable", async ({
  page,
}) => {
  await page.goto(studio);
  await expect(
    page.getByText("未连接文件系统 · 未创建执行 · 无模型费用"),
  ).toBeVisible();
  await page.goto(`${studio}/workspaces/unknown`);
  await expect(
    page.getByRole("heading", { name: "无法打开这个工作区" }),
  ).toBeVisible();
  await expect(page.getByText("未持有写入权", { exact: false })).toBeVisible();
});
test("network failure is explicit and can be retried", async ({ page }) => {
  await page.route("**/api/v1/system/bootstrap", (route) => route.abort());
  await page.goto(workbench);
  await expect(page.getByRole("alert")).toContainText("无法连接本地 API");
  await page.unroute("**/api/v1/system/bootstrap");
  await page.getByRole("button", { name: "重新连接" }).click();
  await expect(page.getByRole("status")).toContainText("本地 API 已连接");
});
test("incompatible API is not displayed as successful connection", async ({
  page,
}) => {
  await page.route("**/api/v1/system/bootstrap", (route) =>
    route.fulfill({ json: { schema_version: "999" } }),
  );
  await page.goto(studio);
  await expect(page.getByRole("alert")).toContainText("服务与客户端版本不兼容");
});
test("unknown management page is recoverable", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173/unknown");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await page.getByRole("link", { name: "返回工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "团队的下一次协作，从这里开始。" }),
  ).toBeVisible();
});
test("mobile viewport stays within screen width and headings remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of [workbench, studio]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  }
});
test("browser has no uncaught application errors during navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(workbench);
  await expect(page.getByRole("status")).toContainText("本地 API 已连接");
  await page.goto(studio);
  await expect(page.getByRole("status")).toContainText("本地 API 已连接");
  expect(errors).toEqual([]);
});
