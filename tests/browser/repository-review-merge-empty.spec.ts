import { test, expect } from "./fixtures.js";
import { createCommitReviewFixture } from "../fixtures/commit-review-data.mjs";

test("review merge: empty source report has no opinion reconciliation controls", async ({
  page,
}) => {
  const f = await createCommitReviewFixture();
  try {
    await page.goto("http://127.0.0.1:5174/org/local/studio");
    await page
      .getByRole("button", { name: "审阅本地代码变更", exact: true })
      .click();
    const panel = page.getByRole("region", {
      name: "本地代码变更审阅",
      exact: true,
    });
    await panel.getByLabel("比较报告 JSON（最多 4 MiB）").setInputFiles({
      name: "empty.json",
      mimeType: "application/json",
      buffer: Buffer.from(f.empty),
    });
    await panel
      .getByRole("button", { name: "导入比较报告", exact: true })
      .click();
    await expect(panel.getByRole("status")).toHaveText(
      "报告格式已检查 · 来源仍未认证",
    );
    await expect(
      panel.getByText("原报告没有变更文件，无可汇总的文件意见。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel.getByLabel("待合并意见 JSON（最多 512 KiB）", { exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "预览意见合并", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("region", { name: "合并预览", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: /批准|合并|执行/ }),
    ).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});
