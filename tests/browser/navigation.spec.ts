import { test, expect } from "./fixtures.js";
const base = "http://127.0.0.1:5173";
test("workbench navigation: local entry reports disabled organization service without exposing fake data", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET")
      writes.push(request.method());
  });
  await page.goto(base + "/org/local/workbench");
  await page.getByRole("link", { name: "组织工作台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "组织服务尚未启用" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "组织服务尚未启用" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "组织导航" })).toHaveCount(
    0,
  );
  expect(writes).toEqual([]);
});
test("workbench navigation: unavailable business paths never fall back to an authorized dashboard", async ({
  page,
}) => {
  await page.goto(
    base + "/org/00000000-0000-4000-8000-000000000001/workbench/projects",
  );
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "组织导航" })).toHaveCount(
    0,
  );
});
