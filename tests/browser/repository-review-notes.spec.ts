import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createCommitReviewFixture } from "../fixtures/commit-review-data.mjs";

const panel = (page: Page) =>
  page.getByRole("region", { name: "本地代码变更审阅", exact: true });
const notes = (page: Page) =>
  page.getByRole("region", { name: "文件审阅意见交接", exact: true });
async function open(page: Page) {
  await page.goto("http://127.0.0.1:5174/org/local/studio");
  await page
    .getByRole("button", { name: "审阅本地代码变更", exact: true })
    .click();
}
async function loadReport(page: Page, text: string) {
  await panel(page)
    .getByLabel("比较报告 JSON（最多 4 MiB）")
    .setInputFiles({
      name: "report.json",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
  await panel(page)
    .getByRole("button", { name: "导入比较报告", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "报告格式已检查 · 来源仍未认证",
  );
}
async function select(page: Page) {
  await panel(page)
    .getByRole("button", { name: "修改 src/example.ts", exact: true })
    .click();
}
async function add(page: Page, body = "Please explain this change.") {
  await notes(page).getByLabel("自填署名（未认证）").fill("Reviewer fixture");
  await notes(page).getByLabel("意见正文（最多 4000 UTF-8 字节）").fill(body);
  await notes(page)
    .getByRole("button", { name: "添加文件意见", exact: true })
    .click();
  await expect(notes(page).getByText(body, { exact: true })).toBeVisible();
}
function interchange(report: string, count = 1) {
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
    notes: Array.from({ length: count }, (_, i) => ({
      id: `fixture-${i}`,
      path: "src/example.ts",
      kind: "question",
      author: "Import fixture",
      body: `Imported comment ${i}`,
    })),
  });
}
async function chooseNotes(page: Page, data: string | Buffer) {
  await notes(page)
    .getByLabel("意见交接 JSON（最多 512 KiB）")
    .setInputFiles({
      name: "notes.json",
      mimeType: "application/json",
      buffer: Buffer.from(data),
    });
}
async function importNotes(page: Page, data: string | Buffer) {
  await chooseNotes(page, data);
  await notes(page)
    .getByRole("button", { name: "导入文件意见", exact: true })
    .click();
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

test("review notes: explicit file selection, draft isolation and removal", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail);
    await expect(
      notes(page).getByRole("button", { name: "添加文件意见" }),
    ).toHaveCount(0);
    await select(page);
    await add(page);
    await notes(page)
      .getByLabel("意见正文（最多 4000 UTF-8 字节）")
      .fill("Unsaved draft");
    await panel(page)
      .getByRole("button", { name: "新增 added.txt", exact: true })
      .click();
    await expect(
      notes(page).getByLabel("意见正文（最多 4000 UTF-8 字节）"),
    ).toHaveValue("");
    await expect(
      notes(page).getByText("Please explain this change.", { exact: true }),
    ).toBeVisible();
    await notes(page)
      .getByRole("button", { name: "移除意见 1", exact: true })
      .click();
    await expect(
      notes(page).getByText("Please explain this change.", { exact: true }),
    ).toHaveCount(0);
  });
});
test("review notes: actual download and separate session reimport bind the original report", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail);
    await select(page);
    await add(page);
    await notes(page)
      .getByRole("button", { name: "准备意见交接文件", exact: true })
      .click();
    const pending = page.waitForEvent("download");
    await notes(page)
      .getByRole("link", { name: "下载审阅意见 JSON", exact: true })
      .click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe("zentwine-review-notes.json");
    const text = await fs.readFile((await download.path())!, "utf8");
    const value = JSON.parse(text);
    expect(value.binding.report_sha256).toBe(
      createHash("sha256").update(f.detail).digest("hex"),
    );
    expect(value.notes).toHaveLength(1);
    expect(value.authorization).toBe(false);
    expect(text).not.toContain("<img");
    await page.reload();
    await page
      .getByRole("button", { name: "审阅本地代码变更", exact: true })
      .click();
    await loadReport(page, f.detail);
    await chooseNotes(page, text);
    await expect(
      notes(page).getByText("意见文件已选择，尚未读取。", { exact: true }),
    ).toBeVisible();
    await expect(
      notes(page).getByText("Please explain this change.", { exact: true }),
    ).toHaveCount(0);
    await notes(page)
      .getByRole("button", { name: "导入文件意见", exact: true })
      .click();
    await expect(
      notes(page).getByText("Please explain this change.", { exact: true }),
    ).toBeVisible();
    await expect(
      notes(page).getByText("意见已导入；内容绑定一致，来源和署名仍未认证。", {
        exact: true,
      }),
    ).toBeVisible();
    await fs.mkdir("reports/screenshots", { recursive: true });
    await notes(page).screenshot({
      path: "reports/screenshots/review-notes.png",
    });
  });
});
test("review notes: changed bytes with the same commit pair refuse stale notes and recover", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail + "\n");
    await importNotes(page, interchange(f.detail));
    await expect(notes(page).getByRole("alert")).toContainText(
      "不属于这份原报告",
    );
    await expect(
      notes(page).getByText("Imported comment 0", { exact: true }),
    ).toHaveCount(0);
    await importNotes(page, interchange(f.detail + "\n"));
    await expect(
      notes(page).getByText("Imported comment 0", { exact: true }),
    ).toBeVisible();
  });
});
test("review notes: pending import is discarded by adding and cannot overwrite existing opinions", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail);
    await select(page);
    await chooseNotes(page, interchange(f.detail));
    await add(page);
    await expect(
      notes(page).getByRole("button", { name: "导入文件意见", exact: true }),
    ).toBeDisabled();
    await expect(
      notes(page).getByLabel("意见交接 JSON（最多 512 KiB）"),
    ).toBeDisabled();
    await expect(
      notes(page).getByText("Imported comment 0", { exact: true }),
    ).toHaveCount(0);
    await notes(page)
      .getByRole("button", { name: "清除全部意见", exact: true })
      .click();
    await importNotes(page, interchange(f.detail));
    await expect(
      notes(page).getByText("Imported comment 0", { exact: true }),
    ).toBeVisible();
  });
});
test("review notes: invalid/duplicate/oversized/UTF8 input rejects without echo", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail);
    for (const data of [
      '{"private":"NO-ECHO"',
      Buffer.from([255, 254]),
      interchange(f.detail).replace('"notes":', '"notes":[],"notes":'),
    ]) {
      await importNotes(page, data);
      await expect(notes(page).getByRole("alert")).toContainText(
        "未导入任何意见",
      );
      await expect(
        notes(page).getByText("NO-ECHO", { exact: false }),
      ).toHaveCount(0);
    }
    await chooseNotes(page, Buffer.alloc(524289, 32));
    await expect(notes(page).getByRole("alert")).toContainText("未读取内容");
    await expect(
      notes(page).getByRole("button", { name: "导入文件意见", exact: true }),
    ).toBeDisabled();
  });
});
test("review notes: object URLs are revoked on change clear and report unmount", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const host = globalThis as unknown as { activeNoteUrls: string[] };
    host.activeNoteUrls = [];
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      const result = create(value);
      host.activeNoteUrls.push(result);
      return result;
    };
    URL.revokeObjectURL = (value) => {
      host.activeNoteUrls = host.activeNoteUrls.filter((v) => v !== value);
      revoke(value);
    };
  });
  const active = () =>
    page.evaluate(
      () =>
        (globalThis as unknown as { activeNoteUrls: string[] }).activeNoteUrls
          .length,
    );
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail);
    await select(page);
    await add(page);
    await notes(page)
      .getByRole("button", { name: "准备意见交接文件", exact: true })
      .click();
    expect(await active()).toBe(1);
    await add(page, "Second opinion");
    expect(await active()).toBe(0);
    await expect(notes(page).getByRole("link")).toHaveCount(0);
    await notes(page)
      .getByRole("button", { name: "准备意见交接文件", exact: true })
      .click();
    await notes(page)
      .getByRole("button", { name: "清除全部意见", exact: true })
      .click();
    expect(await active()).toBe(0);
    await select(page);
    await add(page);
    await notes(page)
      .getByRole("button", { name: "准备意见交接文件", exact: true })
      .click();
    await panel(page)
      .getByRole("button", { name: "关闭变更审阅", exact: true })
      .click();
    expect(await active()).toBe(0);
    await expect(notes(page)).toHaveCount(0);
  });
});
test("review notes: hostile text stays inert and no network or storage writes occur", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail);
    await select(page);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    const body = '<img src="https://example.invalid" onerror="alert(1)">\u202E';
    await notes(page).getByLabel("自填署名（未认证）").fill("Tester");
    await notes(page).getByLabel("意见正文（最多 4000 UTF-8 字节）").fill(body);
    await notes(page)
      .getByRole("button", { name: "添加文件意见", exact: true })
      .click();
    await expect(notes(page).locator(".review-note-body")).toHaveText(
      body.replace("\u202E", "\\u{202E}"),
    );
    await expect(notes(page).locator("img, script, iframe")).toHaveCount(0);
    await notes(page)
      .getByRole("button", { name: "准备意见交接文件", exact: true })
      .click();
    await notes(page)
      .getByRole("button", { name: "清除全部意见", exact: true })
      .click();
    await importNotes(page, interchange(f.detail));
    await expect(
      notes(page).getByText("Imported comment 0", { exact: true }),
    ).toBeVisible();
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
async function delayNotes(page: Page) {
  await page.evaluate(() => {
    const host = globalThis as unknown as {
      releaseNotes: (() => Promise<void>)[];
    };
    host.releaseNotes = [];
    const Native = FileReader;
    globalThis.FileReader = class extends Native {
      override readAsArrayBuffer(blob: Blob) {
        host.releaseNotes.push(
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
async function release(page: Page) {
  await page.evaluate(() =>
    (globalThis as unknown as { releaseNotes: (() => Promise<void>)[] })
      .releaseNotes[0]!(),
  );
}
test("review notes: cancellation blocks late native completion", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail);
    await delayNotes(page);
    await importNotes(page, interchange(f.detail));
    await notes(page)
      .getByRole("button", { name: "取消意见读取", exact: true })
      .click();
    await release(page);
    await expect(
      notes(page).getByText("Imported comment 0", { exact: true }),
    ).toHaveCount(0);
    await expect(
      notes(page).getByText("意见读取已取消。", { exact: true }),
    ).toBeVisible();
  });
});
test("review notes: read deadline and report replacement invalidate pending notes", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await loadReport(page, f.detail);
    await delayNotes(page);
    await page.clock.install();
    await importNotes(page, interchange(f.detail));
    await page.clock.fastForward(10001);
    await expect(notes(page).getByRole("alert")).toContainText("读取超时");
    await release(page);
    await expect(
      notes(page).getByText("Imported comment 0", { exact: true }),
    ).toHaveCount(0);
    await importNotes(page, interchange(f.detail));
    await panel(page)
      .getByRole("button", { name: "清除报告与正文", exact: true })
      .click();
    await page.evaluate(() =>
      (globalThis as unknown as { releaseNotes: (() => Promise<void>)[] })
        .releaseNotes[1]!(),
    );
    await expect(notes(page)).toHaveCount(0);
  });
});
test("review notes: bounded pagination and narrow keyboard form work across themes", async ({
  page,
}) => {
  await fixture(async (f) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await loadReport(page, f.detail);
    await importNotes(page, interchange(f.detail, 11));
    await expect(notes(page).locator(".review-notes-list li")).toHaveCount(10);
    await notes(page)
      .getByRole("button", { name: "下一页意见", exact: true })
      .click();
    await expect(notes(page).locator(".review-notes-list li")).toHaveCount(1);
    await notes(page)
      .getByRole("button", { name: "清除全部意见", exact: true })
      .click();
    await select(page);
    await notes(page).getByLabel("自填署名（未认证）").fill("Keyboard fixture");
    await notes(page)
      .getByLabel("意见正文（最多 4000 UTF-8 字节）")
      .fill("Keyboard opinion");
    const button = notes(page).getByRole("button", {
      name: "添加文件意见",
      exact: true,
    });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(
      notes(page).getByText("Keyboard opinion", { exact: true }),
    ).toBeVisible();
    for (const theme of ["light", "dark", "contrast"]) {
      await page.getByLabel("外观").selectOption(theme);
      const bounds = await notes(page).boundingBox();
      const input = await notes(page)
        .getByLabel("意见正文（最多 4000 UTF-8 字节）")
        .boundingBox();
      expect(input!.width).toBeGreaterThan(bounds!.width * 0.8);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    }
    await fs.mkdir("reports/screenshots", { recursive: true });
    await notes(page).screenshot({
      path: "reports/screenshots/review-notes-mobile.png",
    });
  });
});
test("review notes: late source digest after cancellation never creates a note session", async ({
  page,
}) => {
  await fixture(async (f) => {
    await open(page);
    await page.evaluate(() => {
      const host = globalThis as unknown as {
        releaseSourceDigest?: () => void;
      };
      crypto.subtle.digest = () =>
        new Promise<ArrayBuffer>((resolve) => {
          host.releaseSourceDigest = () => resolve(new ArrayBuffer(32));
        });
    });
    await panel(page)
      .getByLabel("比较报告 JSON（最多 4 MiB）")
      .setInputFiles({
        name: "report.json",
        mimeType: "application/json",
        buffer: Buffer.from(f.detail),
      });
    await panel(page)
      .getByRole("button", { name: "导入比较报告", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        typeof (globalThis as unknown as { releaseSourceDigest?: () => void })
          .releaseSourceDigest === "function",
    );
    await panel(page)
      .getByRole("button", { name: "取消读取", exact: true })
      .click();
    await page.evaluate(() =>
      (
        globalThis as unknown as { releaseSourceDigest: () => void }
      ).releaseSourceDigest(),
    );
    await expect(panel(page).getByRole("status")).toHaveText("尚未导入报告");
    await expect(notes(page)).toHaveCount(0);
  });
});
