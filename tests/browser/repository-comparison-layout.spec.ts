import { test, expect } from "./fixtures.js";

test("comparison viewer: narrow file picker has a full row instead of being squeezed by actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:5174/org/local/studio");
  await page
    .getByRole("button", { name: "审阅本地代码变更", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "本地代码变更审阅",
    exact: true,
  });
  const input = panel.getByLabel("比较报告 JSON（最多 4 MiB）");
  for (const theme of ["light", "dark", "contrast"]) {
    await page.getByLabel("外观").selectOption(theme);
    const picker = await input.boundingBox();
    const bounds = await panel.boundingBox();
    expect(picker).not.toBeNull();
    expect(bounds).not.toBeNull();
    expect(picker!.width).toBeGreaterThan(bounds!.width * 0.8);
    await expect(input).toBeVisible();
  }
  await input.setInputFiles({
    name: "local-report.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await expect(panel.getByRole("status")).toHaveText("文件已选择，尚未读取");
});
