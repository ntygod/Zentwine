import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createCommitReviewFixture } from "../fixtures/commit-review-data.mjs";

// Real Git and CLI report, synthetic reviewers; no production/model calls.
const panel = (p: Page) =>
  p.getByRole("region", { name: "本地代码变更审阅", exact: true });
const notes = (p: Page) =>
  p.getByRole("region", { name: "文件审阅意见交接", exact: true });
const preview = (p: Page) =>
  p.getByRole("region", { name: "合并预览", exact: true });
const current = (p: Page) => notes(p).locator(":scope > ol.review-notes-list");
const note = (id: string, body = `Opinion ${id}`) => ({
  id,
  path: "src/example.ts",
  kind: "question",
  author: "Synthetic reviewer",
  body,
});
function file(report: string, items: ReturnType<typeof note>[]) {
  const c = JSON.parse(report).comparison;
  return JSON.stringify({
    schema_version: "1.0.0",
    scope: "local_repository_review_notes",
    trust: "unverified_local_notes",
    authorization: false,
    binding: {
      report_sha256: createHash("sha256").update(report).digest("hex"),
      object_format: c.object_format,
      base: c.base,
      head: c.head,
    },
    notes: items,
  });
}
async function load(
  page: Page,
  report: string,
  items: ReturnType<typeof note>[] = [note("a")],
) {
  await page.goto("http://127.0.0.1:5174/org/local/studio");
  await page
    .getByRole("button", { name: "审阅本地代码变更", exact: true })
    .click();
  await panel(page)
    .getByLabel("比较报告 JSON（最多 4 MiB）")
    .setInputFiles({
      name: "report.json",
      mimeType: "application/json",
      buffer: Buffer.from(report),
    });
  await panel(page)
    .getByRole("button", { name: "导入比较报告", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "报告格式已检查 · 来源仍未认证",
  );
  await notes(page)
    .getByLabel("意见交接 JSON（最多 512 KiB）", { exact: true })
    .setInputFiles({
      name: "current.json",
      mimeType: "application/json",
      buffer: Buffer.from(file(report, items)),
    });
  await notes(page)
    .getByRole("button", { name: "导入文件意见", exact: true })
    .click();
  await expect(
    notes(page).getByText("意见已导入；内容绑定一致，来源和署名仍未认证。", {
      exact: true,
    }),
  ).toBeVisible();
}
async function choose(page: Page, data: string | Buffer) {
  await notes(page)
    .getByLabel("待合并意见 JSON（最多 512 KiB）", { exact: true })
    .setInputFiles({
      name: "incoming.json",
      mimeType: "application/json",
      buffer: Buffer.from(data),
    });
}
async function start(page: Page, data: string | Buffer) {
  await choose(page, data);
  await notes(page)
    .getByRole("button", { name: "预览意见合并", exact: true })
    .click();
}
const confirm = (page: Page) =>
  preview(page).getByRole("button", { name: "确认合并意见", exact: true });
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
async function download(page: Page) {
  await notes(page)
    .getByRole("button", { name: "准备意见交接文件", exact: true })
    .click();
  const pending = page.waitForEvent("download");
  await notes(page)
    .getByRole("link", { name: "下载审阅意见 JSON", exact: true })
    .click();
  return fs.readFile((await (await pending).path())!, "utf8");
}

test("review merge: explicit preview then confirmation exports a reusable v1 combined set", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    await choose(page, file(f.detail, [note("b")]));
    await expect(preview(page)).toHaveCount(0);
    await expect(current(page).locator("li")).toHaveCount(1);
    await notes(page)
      .getByRole("button", { name: "预览意见合并", exact: true })
      .click();
    await expect(preview(page)).toContainText("新增 1 条");
    await expect(current(page).locator("li")).toHaveCount(1);
    await confirm(page).click();
    await expect(preview(page)).toHaveCount(0);
    await expect(current(page).locator("li")).toHaveCount(2);
    const text = await download(page),
      output = JSON.parse(text);
    expect(output.notes).toEqual([note("a"), note("b")]);
    expect(output.authorization).toBe(false);
    expect(output.schema_version).toBe("1.0.0");
    // A fresh page session, not retained UI state, consumes the old-format result.
    await load(page, f.detail, output.notes);
    await expect(current(page).locator("li")).toHaveCount(2);
  });
});
test("review merge: exact duplicates are idempotent and different IDs keep matching text", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    const incoming = file(f.detail, [note("a"), note("b", "Opinion a")]);
    await start(page, incoming);
    await expect(preview(page)).toContainText("完全重复 1 条");
    await confirm(page).click();
    await start(page, incoming);
    await expect(preview(page)).toContainText("新增 0 条");
    await expect(preview(page)).toContainText("完全重复 2 条");
    await confirm(page).click();
    await expect(current(page).locator("li")).toHaveCount(2);
  });
});
test("review merge: conflict defaults are blank and explicit current or incoming both work", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    const incoming = file(f.detail, [
      {
        ...note("a", "Changed opinion"),
        author: "Another unverified name",
        path: "added.txt",
        kind: "issue",
      },
    ]);
    await start(page, incoming);
    await expect(confirm(page)).toBeDisabled();
    await expect(preview(page).getByLabel("冲突处理 a")).toHaveValue("");
    await expect(preview(page)).toContainText("Another unverified name");
    await preview(page).getByLabel("冲突处理 a").selectOption("current");
    await confirm(page).click();
    await expect(current(page)).toContainText("Opinion a");
    await start(page, incoming);
    await expect(confirm(page)).toBeDisabled();
    await preview(page).getByLabel("冲突处理 a").selectOption("incoming");
    await confirm(page).click();
    await expect(current(page)).toContainText("Changed opinion");
    await expect(current(page)).toContainText("added.txt");
    await expect(current(page)).not.toContainText("Opinion a");
  });
});
test("review merge: all conflicts across bounded pages require decisions", async ({
  page,
}) => {
  await fixture(async (f) => {
    const a = Array.from({ length: 11 }, (_, i) => note(`n-${i}`));
    await load(page, f.detail, a);
    await start(
      page,
      file(
        f.detail,
        a.map((n) => ({ ...n, body: "Updated" })),
      ),
    );
    await expect(preview(page).locator("li")).toHaveCount(10);
    for (let i = 0; i < 10; i++)
      await preview(page)
        .getByLabel(`冲突处理 n-${i}`, { exact: true })
        .selectOption("current");
    await expect(confirm(page)).toBeDisabled();
    await preview(page)
      .getByRole("button", { name: "下一页预览", exact: true })
      .click();
    await expect(preview(page).locator("li")).toHaveCount(1);
    await preview(page)
      .getByLabel("冲突处理 n-10", { exact: true })
      .selectOption("incoming");
    await expect(confirm(page)).toBeEnabled();
    await preview(page)
      .getByRole("button", { name: "上一页预览", exact: true })
      .click();
    await expect(
      preview(page).getByLabel("冲突处理 n-0", { exact: true }),
    ).toHaveValue("current");
    await confirm(page).click();
    const output = JSON.parse(await download(page));
    expect(output.notes.slice(0, 10)).toEqual(a.slice(0, 10));
    expect(output.notes[10].body).toBe("Updated");
  });
});
test("review merge: cancelled preview preserves drafts and the prepared download URL", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    await panel(page)
      .getByRole("button", { name: "修改 src/example.ts", exact: true })
      .click();
    const draft = notes(page).getByLabel("意见正文（最多 4000 UTF-8 字节）");
    await draft.fill("Unsaved draft");
    await notes(page)
      .getByRole("button", { name: "准备意见交接文件", exact: true })
      .click();
    const link = notes(page).getByRole("link", {
      name: "下载审阅意见 JSON",
      exact: true,
    });
    const href = await link.getAttribute("href");
    await start(page, file(f.detail, [note("b")]));
    await expect(draft).toBeDisabled();
    await expect(
      notes(page).getByRole("button", { name: "移除意见 1", exact: true }),
    ).toBeDisabled();
    await preview(page)
      .getByRole("button", { name: "取消合并预览", exact: true })
      .click();
    await expect(draft).toHaveValue("Unsaved draft");
    await expect(link).toHaveAttribute("href", href!);
    await expect(current(page).locator("li")).toHaveCount(1);
    await start(page, file(f.detail, [note("b")]));
    await confirm(page).click();
    await expect(link).toHaveCount(0);
    await expect(draft).toHaveValue("");
  });
});
test("review merge: new selection replaces preview and resets old decisions", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    await start(page, file(f.detail, [note("a", "First incoming")]));
    await preview(page).getByLabel("冲突处理 a").selectOption("incoming");
    await choose(page, file(f.detail, [note("a", "Second incoming")]));
    await expect(preview(page)).toHaveCount(0);
    await notes(page)
      .getByRole("button", { name: "预览意见合并", exact: true })
      .click();
    await expect(confirm(page)).toBeDisabled();
    await expect(preview(page)).not.toContainText("First incoming");
    await notes(page)
      .getByRole("button", { name: "清除全部意见", exact: true })
      .click();
    await expect(preview(page)).toHaveCount(0);
    await expect(current(page).locator("li")).toHaveCount(0);
  });
});
test("review merge: invalid and mismatched files keep existing notes and allow recovery", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    await notes(page)
      .getByRole("button", { name: "准备意见交接文件", exact: true })
      .click();
    const href = await notes(page).getByRole("link").getAttribute("href");
    for (const invalid of [
      "{}",
      file(f.detail + "\n", [note("b")]),
      Buffer.from([0xff]),
    ]) {
      await start(page, invalid);
      await expect(notes(page).getByRole("alert")).toContainText(
        "当前意见未改变",
      );
      await expect(preview(page)).toHaveCount(0);
      await expect(current(page).locator("li")).toHaveCount(1);
      await expect(notes(page).getByRole("link")).toHaveAttribute(
        "href",
        href!,
      );
    }
    await choose(page, Buffer.alloc(524289, 32));
    await expect(notes(page).getByRole("alert")).toContainText("未读取内容");
    await start(page, file(f.detail, [note("b")]));
    await confirm(page).click();
    await expect(current(page).locator("li")).toHaveCount(2);
  });
});
test("review merge: combined count and escaped-byte limits never partially apply", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(
      page,
      f.detail,
      Array.from({ length: 100 }, (_, i) => note(`n-${i}`)),
    );
    await start(page, file(f.detail, [note("extra")]));
    await expect(notes(page).getByRole("alert")).toContainText("合并条数超限");
    await expect(
      notes(page).getByRole("heading", { name: "当前意见集（100 / 100）" }),
    ).toBeVisible();
    const a = Array.from({ length: 12 }, (_, i) =>
      note(`a-${i}`, "\x01".repeat(3999)),
    );
    const b = Array.from({ length: 12 }, (_, i) =>
      note(`b-${i}`, "\x01".repeat(3999)),
    );
    await load(page, f.detail, a);
    await start(page, file(f.detail, b));
    await confirm(page).click();
    await expect(notes(page).getByRole("alert")).toContainText(
      "整体超过 512 KiB",
    );
    await expect(preview(page)).toBeVisible();
    await expect(
      notes(page).getByRole("heading", { name: "当前意见集（12 / 100）" }),
    ).toBeVisible();
  });
});
async function delay(page: Page) {
  await page.evaluate(() => {
    const host = globalThis as unknown as {
      mergeReads: (() => Promise<boolean>)[];
    };
    host.mergeReads = [];
    const Native = FileReader;
    globalThis.FileReader = class extends Native {
      override readAsArrayBuffer(blob: Blob) {
        host.mergeReads.push(
          () =>
            new Promise<boolean>((resolve) => {
              this.addEventListener(
                "loadend",
                () =>
                  resolve(
                    this.result instanceof ArrayBuffer &&
                      new Uint8Array(this.result).every((b) => b === 0),
                  ),
                { once: true },
              );
              super.readAsArrayBuffer(blob);
            }),
        );
      }
    };
  });
}
const release = (page: Page, index = 0) =>
  page.evaluate(
    (i) =>
      (globalThis as unknown as { mergeReads: (() => Promise<boolean>)[] })
        .mergeReads[i]!(),
    index,
  );
test("review merge: cancel and replaced pending reads cannot restore old previews", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    await delay(page);
    await start(page, file(f.detail, [note("b")]));
    await notes(page)
      .getByRole("button", { name: "取消意见读取", exact: true })
      .click();
    expect(await release(page)).toBe(true);
    await expect(preview(page)).toHaveCount(0);
    await start(page, file(f.detail, [note("old")]));
    await start(page, file(f.detail, [note("new")]));
    expect(await release(page, 1)).toBe(true);
    await expect(preview(page)).toHaveCount(0);
    expect(await release(page, 2)).toBe(true);
    await expect(preview(page)).toContainText("Opinion new");
    await expect(preview(page)).not.toContainText("Opinion old");
    await confirm(page).click();
    await expect(current(page).locator("li")).toHaveCount(2);
  });
});
test("review merge: timeout and unmount invalidate pending reads", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    await delay(page);
    await page.clock.install();
    await start(page, file(f.detail, [note("b")]));
    await page.clock.fastForward(10001);
    await expect(notes(page).getByRole("alert")).toContainText("读取超时");
    expect(await release(page)).toBe(true);
    await expect(preview(page)).toHaveCount(0);
    await start(page, file(f.detail, [note("b")]));
    await panel(page)
      .getByRole("button", { name: "清除报告与正文", exact: true })
      .click();
    expect(await release(page, 1)).toBe(true);
    await expect(notes(page)).toHaveCount(0);
  });
});
test("review merge: hostile preview is inert, no network or browser storage side effects", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    const body = '<img src="https://example.invalid" onerror="alert(1)">\u202E';
    await start(page, file(f.detail, [note("a", body), note("b")]));
    await expect(preview(page).locator("img,script,iframe,a")).toHaveCount(0);
    await expect(preview(page)).toContainText("\\u{202E}");
    await preview(page).getByLabel("冲突处理 a").selectOption("incoming");
    await confirm(page).click();
    await notes(page)
      .getByRole("button", { name: "准备意见交接文件", exact: true })
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
test("review merge: desktop and narrow conflict choices remain usable across themes", async ({
  page,
}) => {
  await fixture(async (f) => {
    await load(page, f.detail);
    await start(
      page,
      file(f.detail, [
        note("a", "Please add an explicit timeout test."),
        note("b", "Document the cancellation boundary."),
      ]),
    );
    await fs.mkdir("reports/screenshots", { recursive: true });
    await preview(page).screenshot({
      path: "reports/screenshots/review-merge.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ["light", "dark", "contrast"]) {
      await page.getByLabel("外观").selectOption(theme);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      const bounds = await preview(page).getByLabel("冲突处理 a").boundingBox();
      expect(bounds!.width).toBeGreaterThan(180);
    }
    await preview(page).screenshot({
      path: "reports/screenshots/review-merge-mobile.png",
    });
    await preview(page).getByLabel("冲突处理 a").selectOption("incoming");
    await confirm(page).focus();
    await page.keyboard.press("Enter");
    await expect(current(page)).toContainText(
      "Please add an explicit timeout test.",
    );
    await expect(preview(page)).toHaveCount(0);
  });
});
