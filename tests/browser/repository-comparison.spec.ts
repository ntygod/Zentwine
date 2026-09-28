import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import fs from "node:fs/promises";
import { createCommitReviewFixture } from "../fixtures/commit-review-data.mjs";
const studio = "http://127.0.0.1:5174/org/local/studio";
const region = (page: Page) =>
  page.getByRole("region", { name: "本地代码变更审阅", exact: true });
async function open(page: Page) {
  await page.goto(studio);
  await page
    .getByRole("button", { name: "审阅本地代码变更", exact: true })
    .click();
  await expect(
    region(page).getByRole("heading", {
      name: "本地代码变更审阅",
      exact: true,
    }),
  ).toBeFocused();
}
async function choose(page: Page, text: string | Buffer) {
  await region(page)
    .getByLabel("比较报告 JSON（最多 4 MiB）")
    .setInputFiles({
      name: "comparison.json",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
}
async function load(page: Page, text: string) {
  await choose(page, text);
  await region(page)
    .getByRole("button", { name: "导入比较报告", exact: true })
    .click();
  await expect(region(page).getByRole("status")).toHaveText(
    "报告格式已检查 · 来源仍未认证",
  );
}
async function fixture(
  use: (
    f: Awaited<ReturnType<typeof createCommitReviewFixture>>,
  ) => Promise<void>,
) {
  const f = await createCommitReviewFixture();
  try {
    await use(f);
  } finally {
    await f.cleanup();
  }
}

test("comparison viewer: explicit import then explicit file selection reveals real CLI hunks", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await choose(page, f.detail);
    await expect(region(page).getByRole("status")).toHaveText(
      "文件已选择，尚未读取",
    );
    await expect(region(page).getByText(f.base, { exact: true })).toHaveCount(
      0,
    );
    await region(page)
      .getByRole("button", { name: "导入比较报告", exact: true })
      .click();
    await expect(region(page).getByText(f.base, { exact: true })).toBeVisible();
    await expect(region(page).getByRole("table")).toHaveCount(0);
    await region(page)
      .getByRole("button", { name: "修改 src/example.ts", exact: true })
      .click();
    await expect(
      region(page).getByRole("heading", {
        name: "src/example.ts",
        exact: true,
      }),
    ).toBeFocused();
    await expect(region(page).getByRole("table")).toBeVisible();
    await expect(
      region(page).getByText("〔无末尾换行〕", { exact: true }),
    ).toBeVisible();
    await fs.mkdir("reports/screenshots", { recursive: true });
    await region(page).screenshot({
      path: "reports/screenshots/comparison-reviewer.png",
    });
  });
});
test("comparison viewer: hostile code stays text and direction/control characters are visible", async ({
  page,
}) => {
  await fixture(async (f) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("example.invalid")) requests.push(r.url());
    });
    await open(page);
    await load(page, f.detail);
    await region(page)
      .getByRole("button", { name: "修改 src/example.ts", exact: true })
      .click();
    await expect(
      region(page)
        .locator("code")
        .filter({ hasText: '<img src="https://example.invalid' }),
    ).toBeVisible();
    await expect(
      region(page).getByText("\\u{202E}control\\u{0009}line\\u{000D}", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(region(page).locator("img, iframe, script")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { unsafeReview?: boolean }).unsafeReview,
      ),
    ).toBeUndefined();
    expect(requests).toEqual([]);
  });
});
test("comparison viewer: metadata-only and binary reports never invent file bodies", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await load(page, f.listing);
    await region(page)
      .getByRole("button", { name: "修改 src/example.ts", exact: true })
      .click();
    await expect(
      region(page).getByText("此报告未携带该文件正文。", { exact: false }),
    ).toBeVisible();
    await load(page, f.binary);
    await region(page)
      .getByRole("button", { name: "修改 binary.dat", exact: true })
      .click();
    await expect(
      region(page).getByText("二进制或非 UTF-8 文件：不渲染正文。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(region(page).getByRole("table")).toHaveCount(0);
  });
});
test("comparison viewer: empty pair is not a clean-worktree or merge approval", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await load(page, f.empty);
    await expect(
      region(page).getByText(
        "报告未声明文件变更；不代表当前工作区干净或可以合并。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      region(page).getByRole("button", { name: /批准|合并|执行/ }),
    ).toHaveCount(0);
  });
});
test("comparison viewer: malformed replacement removes previous context and recovers", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await load(page, f.detail);
    await choose(page, '{"private":"DO-NOT-ECHO"');
    await expect(region(page).getByText(f.base, { exact: true })).toHaveCount(
      0,
    );
    await region(page)
      .getByRole("button", { name: "导入比较报告", exact: true })
      .click();
    await expect(region(page).getByRole("alert")).toContainText(
      "未保留部分结果",
    );
    await expect(
      region(page).getByText("DO-NOT-ECHO", { exact: false }),
    ).toHaveCount(0);
    await load(page, f.listing);
    await expect(region(page).getByRole("alert")).toHaveCount(0);
  });
});
test("comparison viewer: invalid UTF8 and oversized files fail before rendering", async ({
  page,
}) => {
  await open(page);
  await choose(page, Buffer.from([0xff, 0xfe]));
  await region(page)
    .getByRole("button", { name: "导入比较报告", exact: true })
    .click();
  await expect(region(page).getByRole("alert")).toContainText(
    "报告格式不受支持",
  );
  await choose(page, Buffer.alloc(4194305, 32));
  await expect(region(page).getByRole("alert")).toContainText("未读取内容");
  await expect(
    region(page).getByRole("button", { name: "导入比较报告", exact: true }),
  ).toBeDisabled();
});
test("comparison viewer: clear close reopen and reload do not retain imported context", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await load(page, f.detail);
    await region(page)
      .getByRole("button", { name: "清除报告与正文", exact: true })
      .click();
    await expect(region(page).getByText(f.base, { exact: true })).toHaveCount(
      0,
    );
    await load(page, f.detail);
    await region(page)
      .getByRole("button", { name: "关闭变更审阅", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "审阅本地代码变更", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "审阅本地代码变更", exact: true })
      .click();
    await expect(region(page).getByRole("status")).toHaveText("尚未导入报告");
    await load(page, f.listing);
    await page.reload();
    await expect(region(page)).toHaveCount(0);
  });
});
test("comparison viewer: keyboard selection and path filter preserve explicit disclosure", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await load(page, f.detail);
    await region(page).getByLabel("筛选变更路径").fill("no-match");
    await expect(
      region(page).getByText("没有匹配的变更路径。", { exact: true }),
    ).toBeVisible();
    await region(page).getByLabel("筛选变更路径").fill("example");
    const button = region(page).getByRole("button", {
      name: "修改 src/example.ts",
      exact: true,
    });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(region(page).getByRole("table")).toBeVisible();
  });
});
test("comparison viewer: import viewing and clearing make no requests or browser storage writes", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(`${r.method()} ${r.url()}`));
    await load(page, f.detail);
    await region(page)
      .getByRole("button", { name: "修改 src/example.ts", exact: true })
      .click();
    await region(page)
      .getByRole("button", { name: "清除报告与正文", exact: true })
      .click();
    expect(requests).toEqual([]);
    expect(
      await page.evaluate(async () => ({
        local: localStorage.length,
        session: sessionStorage.length,
        cookies: document.cookie,
        databases: (await indexedDB.databases()).length,
      })),
    ).toEqual({ local: 0, session: 0, cookies: "", databases: 0 });
  });
});
// Delay start of native reads to deterministically simulate late completion after cancellation.
async function delayedReader(page: Page) {
  await page.addInitScript(() => {
    const host = globalThis as unknown as {
      releaseReviewReads: (() => Promise<void>)[];
    };
    host.releaseReviewReads = [];
    const Original = FileReader;
    globalThis.FileReader = class extends Original {
      override readAsArrayBuffer(blob: Blob) {
        host.releaseReviewReads.push(
          () =>
            new Promise<void>((resolve) => {
              this.addEventListener("loadend", () => resolve(), { once: true });
              super.readAsArrayBuffer(blob);
            }),
        );
      }
    };
  });
}
async function release(page: Page, index = 0) {
  await page.evaluate(
    (i) =>
      (globalThis as unknown as { releaseReviewReads: (() => Promise<void>)[] })
        .releaseReviewReads[i]!(),
    index,
  );
}
test("comparison viewer: cancelled native read cannot repopulate cleared state", async ({
  page,
}) => {
  await fixture(async (f) => {
    await delayedReader(page);
    await open(page);
    await choose(page, f.detail);
    await region(page)
      .getByRole("button", { name: "导入比较报告", exact: true })
      .click();
    await region(page)
      .getByRole("button", { name: "取消读取", exact: true })
      .click();
    await release(page);
    await expect(region(page).getByRole("status")).toHaveText("尚未导入报告");
    await expect(region(page).getByText(f.base, { exact: true })).toHaveCount(
      0,
    );
  });
});
test("comparison viewer: newer import wins over a late old file and close discards it", async ({
  page,
}) => {
  await fixture(async (f) => {
    await delayedReader(page);
    await open(page);
    await choose(page, f.detail);
    await region(page)
      .getByRole("button", { name: "导入比较报告", exact: true })
      .click();
    await choose(page, f.empty);
    await region(page)
      .getByRole("button", { name: "导入比较报告", exact: true })
      .click();
    await release(page, 1);
    await expect(
      region(page).getByText(
        "报告未声明文件变更；不代表当前工作区干净或可以合并。",
        { exact: true },
      ),
    ).toBeVisible();
    await release(page, 0);
    await expect(
      region(page).getByRole("button", {
        name: "修改 src/example.ts",
        exact: true,
      }),
    ).toHaveCount(0);
    await region(page)
      .getByRole("button", { name: "关闭变更审阅", exact: true })
      .click();
    await expect(region(page)).toHaveCount(0);
  });
});
test("comparison viewer: selecting runtime inspector unmounts report viewer", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await load(page, f.detail);
    await page
      .getByRole("button", { name: "检查本地交接包", exact: true })
      .click();
    await expect(region(page)).toHaveCount(0);
    await page
      .getByRole("button", { name: "审阅本地代码变更", exact: true })
      .click();
    await expect(region(page).getByRole("status")).toHaveText("尚未导入报告");
    await expect(
      page.getByRole("region", { name: "本地交接检查台", exact: true }),
    ).toHaveCount(0);
  });
});
test("comparison viewer: paged file list and hunks keep DOM bounded", async ({
  page,
}) => {
  await fixture(async (f) => {
    const value = JSON.parse(f.listing),
      source = value.comparison.entries.find(
        (e: { change: string }) => e.change === "added",
      );
    value.comparison.entries = Array.from({ length: 55 }, (_, i) => ({
      ...source,
      path: `file-${i}.txt`,
      after: { ...source.after, path: `file-${i}.txt` },
    }));
    value.comparison.summary = {
      added: 55,
      deleted: 0,
      modified: 0,
      type_changed: 0,
      total: 55,
    };
    await open(page);
    await load(page, JSON.stringify(value));
    await expect(
      region(page)
        .getByRole("region", { name: "变更文件清单", exact: true })
        .locator("li"),
    ).toHaveCount(50);
    await region(page)
      .getByRole("button", { name: "下一页文件", exact: true })
      .click();
    await expect(
      region(page)
        .getByRole("region", { name: "变更文件清单", exact: true })
        .locator("li"),
    ).toHaveCount(5);
    const r = JSON.parse(f.detail);
    const s = r.comparison.selected;
    s.added_lines = 205;
    s.deleted_lines = 1;
    s.hunks = [
      {
        old_start: 1,
        old_lines: 1,
        new_start: 1,
        new_lines: 205,
        lines: [
          {
            kind: "delete",
            old_line: 1,
            new_line: null,
            text: "old",
            newline: true,
          },
          ...Array.from({ length: 205 }, (_, i) => ({
            kind: "insert",
            old_line: null,
            new_line: i + 1,
            text: `line ${i}`,
            newline: true,
          })),
        ],
      },
    ];
    await load(page, JSON.stringify(r));
    await region(page)
      .getByRole("button", { name: "修改 src/example.ts", exact: true })
      .click();
    await expect(region(page).locator("tbody tr")).toHaveCount(100);
    await region(page)
      .getByRole("button", { name: "下一页差异", exact: true })
      .click();
    await expect(region(page).locator("tbody tr")).toHaveCount(100);
    await region(page)
      .getByRole("button", { name: "下一页差异", exact: true })
      .click();
    await expect(region(page).locator("tbody tr")).toHaveCount(6);
  });
});
test("comparison viewer: narrow screen and all themes keep controls usable", async ({
  page,
}) => {
  await fixture(async (f) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await load(page, f.detail);
    await region(page)
      .getByRole("button", { name: "修改 src/example.ts", exact: true })
      .click();
    for (const theme of ["light", "dark", "contrast"]) {
      await page.getByLabel("外观").selectOption(theme);
      await expect(
        region(page).getByRole("button", { name: "关闭变更审阅", exact: true }),
      ).toBeEnabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
    }
    await page.emulateMedia({ forcedColors: "active" });
    await expect(region(page).getByRole("table")).toBeVisible();
    await fs.mkdir("reports/screenshots", { recursive: true });
    await region(page).screenshot({
      path: "reports/screenshots/comparison-reviewer-mobile.png",
    });
  });
});
