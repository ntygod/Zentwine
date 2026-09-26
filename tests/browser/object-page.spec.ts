import { test, expect } from "./fixtures.js";
const org = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222";
test("object default: valid locator stays disabled without identity service and creates no command", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/") && r.method() !== "GET") writes.push(r.url());
  });
  await page.goto(`http://127.0.0.1:5173/org/${org}/workbench/objects/${id}`);
  await expect(
    page.getByRole("heading", { name: "组织服务尚未启用" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "正式记录" })).toHaveCount(0);
  expect(writes).toEqual([]);
});
test("object default: malformed deep link cannot display protected content", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:5173/org/${org}/workbench/objects/not-a-resource`,
  );
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看读取判定" })).toHaveCount(
    0,
  );
});
