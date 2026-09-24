import { test, expect, restrictTestNetwork } from "./fixtures.js";
const url = "http://127.0.0.1:5173/org/local/workbench";
test("separate browser contexts do not share fixture storage or network stubs", async ({
  browser,
}) => {
  const first = await browser.newContext({ serviceWorkers: "block" });
  const second = await browser.newContext({ serviceWorkers: "block" });
  const blockedA = await restrictTestNetwork(first);
  const blockedB = await restrictTestNetwork(second);
  try {
    const a = await first.newPage();
    const b = await second.newPage();
    await a.goto(url);
    await b.goto(url);
    await expect(a.getByRole("status")).toContainText("本地 API 已连接");
    await expect(b.getByRole("status")).toContainText("本地 API 已连接");
    await a.evaluate(() => localStorage.setItem("fixture_only", "tenant-a"));
    expect(
      await b.evaluate(() => localStorage.getItem("fixture_only")),
    ).toBeNull();
    await first.route("**/api/v1/system/bootstrap", (route) => route.abort());
    await Promise.all([a.reload(), b.reload()]);
    await expect(a.getByRole("alert")).toContainText("无法连接本地 API");
    await expect(b.getByRole("status")).toContainText("本地 API 已连接");
  } finally {
    await first.close();
    await second.close();
    expect(blockedA).toEqual([]);
    expect(blockedB).toEqual([]);
  }
});
test("default browser fixture starts clean without previous local storage", async ({
  page,
}) => {
  await page.goto(url);
  expect(
    await page.evaluate(() => localStorage.getItem("fixture_only")),
  ).toBeNull();
  await expect(page.getByRole("status")).toContainText("本地 API 已连接");
});
