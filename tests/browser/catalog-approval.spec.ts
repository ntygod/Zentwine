import { test, expect } from "./fixtures.js";
const org = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222";
test("catalog approval default: request and inspect locators are disabled without services and never post", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/") && r.method() !== "GET") writes.push(r.url());
  });
  for (const suffix of ["objects/" + id + "/rename", "approvals/" + id]) {
    await page.goto(`http://127.0.0.1:5173/org/${org}/workbench/${suffix}`);
    await expect(
      page.getByRole("heading", { name: "组织服务尚未启用" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "提交目录改名申请" }),
    ).toHaveCount(0);
  }
  expect(writes).toEqual([]);
});
test("catalog approval default: malformed approval path cannot expose decision controls", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:5173/org/${org}/workbench/approvals/not-an-id`,
  );
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "打开目录操作确认" }),
  ).toHaveCount(0);
});
