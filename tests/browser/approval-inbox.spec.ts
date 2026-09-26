import { test, expect } from "./fixtures.js";
const org = "11111111-1111-4111-8111-111111111111";
test("inbox default: disabled service cannot invent approval records or submit writes", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/") && r.method() !== "GET") writes.push(r.url());
  });
  await page.goto(`http://127.0.0.1:5173/org/${org}/workbench/approvals`);
  await expect(
    page.getByRole("heading", { name: "组织服务尚未启用" }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "审批记录列表" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "应用筛选" })).toHaveCount(0);
  expect(writes).toEqual([]);
});
test("inbox default: invalid tenant deep link cannot mount a protected list", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:5173/org/not-an-id/workbench/approvals");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await expect(page.getByRole("list", { name: "审批记录列表" })).toHaveCount(0);
});
