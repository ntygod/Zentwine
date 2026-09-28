import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import { inspectionFixture } from "../fixtures/runtime-inspection-data.mjs";
const studio = "http://127.0.0.1:5174/org/local/studio";
const file = (name: string, value: string | Uint8Array) => ({
  name, mimeType: "application/octet-stream", buffer: Buffer.from(value),
});
async function open(page: Page) {
  await page.goto(studio);
  await page.getByRole("button", { name: "检查本地交接包" }).click();
  await expect(page.getByRole("heading", { name: "本地交接检查台" })).toBeVisible();
}
async function plan(page: Page, value = inspectionFixture().plan, name = "plan.json") {
  await page.getByLabel("交接计划 JSON（最多 256 KiB）").setInputFiles(file(name, JSON.stringify(value)));
  await expect(page.getByTestId("inspection-result")).toHaveText("待选择文件");
}
async function select(page: Page, f = inspectionFixture()) {
  for (let i = 0; i < f.events.length; i++) {
    await page.getByLabel(new RegExp(`^生产事件 ${i + 1}`)).setInputFiles(file(`events-${i}.ndjson`, f.events[i]));
  }
  for (let i = 0; i < f.bytes.length; i++) {
    await page.getByLabel(new RegExp(`^输入产物 ${i + 1}`)).setInputFiles(file(`artifact-${i}.bin`, f.bytes[i]));
  }
}

test("runtime inspector: explicit local multi-producer check uses real browser crypto and releases content", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await plan(page);
  await select(page);
  await page.getByRole("button", { name: "开始本地检查" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveText("字节校验通过（未授权执行）");
  await expect(page.getByText("全部声明输入已核对", { exact: false })).toBeVisible();
  expect(await page.locator('input[type="file"]').evaluateAll((nodes) => nodes.every((n) => (n as HTMLInputElement).files?.length === 0))).toBe(true);
  fs.mkdirSync("reports/screenshots", { recursive: true });
  await page.getByRole("region", { name: "本地交接检查台", exact: true }).screenshot({ path: "reports/screenshots/runtime-inspector-passed.png" });
  expect(errors).toEqual([]);
});

test("runtime inspector: missing inputs never enable checking", async ({ page }) => {
  await open(page);
  await plan(page);
  await page.getByLabel(/^生产事件 1/).setInputFiles(file("events.ndjson", inspectionFixture().events[0]));
  await expect(page.getByRole("button", { name: "开始本地检查" })).toBeDisabled();
  await expect(page.getByTestId("inspection-result")).toHaveText("待选择文件");
});

test("runtime inspector: same-size corrupt artifact rejects the entire inspection", async ({ page }) => {
  const f = inspectionFixture();
  f.bytes[1][0] ^= 1;
  await open(page);
  await plan(page, f.plan);
  await select(page, f);
  await page.getByRole("button", { name: "开始本地检查" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveText("检查未通过");
  await expect(page.getByRole("alert")).toContainText("未交付任何内容");
  fs.mkdirSync("reports/screenshots", { recursive: true });
  await page.getByRole("region", { name: "本地交接检查台", exact: true }).screenshot({ path: "reports/screenshots/runtime-inspector-rejected.png" });
});

test("runtime inspector: invalid producer report prevents opening any artifact stream", async ({ page }) => {
  const f = inspectionFixture();
  f.events[0] = f.events[0].replace(/\n$/, "");
  await open(page);
  await plan(page, f.plan);
  await select(page, f);
  await page.evaluate(() => {
    const original = Blob.prototype.stream;
    Object.assign(window, { inspectionStreams: 0 });
    Blob.prototype.stream = function () {
      Reflect.set(window, "inspectionStreams", Reflect.get(window, "inspectionStreams") + 1);
      return original.call(this);
    };
  });
  await page.getByRole("button", { name: "开始本地检查" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveText("检查未通过");
  expect(await page.evaluate(() => Reflect.get(window, "inspectionStreams"))).toBe(2);
});

test("runtime inspector: duplicate plan keys and untrusted contents are rejected without echo", async ({ page }) => {
  await open(page);
  await page.getByLabel("交接计划 JSON（最多 256 KiB）").setInputFiles(file("bad.json", '{"consumer":{},"cons\\u0075mer":{"secret":"never-echo-this"}}'));
  await expect(page.getByRole("alert")).toContainText("无法读取计划");
  await expect(page.getByText("never-echo-this")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始本地检查" })).toHaveCount(0);
});

test("runtime inspector: oversized plan and oversized artifact selections fail before checking", async ({ page }) => {
  await open(page);
  await page.getByLabel("交接计划 JSON（最多 256 KiB）").setInputFiles(file("large.json", " ".repeat(262145)));
  await expect(page.getByRole("alert")).toContainText("256 KiB");
  await plan(page);
  await select(page);
  await page.getByLabel(/^输入产物 1/).setInputFiles(file("large.bin", new Uint8Array(1024)));
  await expect(page.getByRole("alert")).toContainText("超过此条目");
  await expect(page.getByRole("button", { name: "开始本地检查" })).toBeDisabled();
});

test("runtime inspector: clearing a hanging read cancels readers and prevents stale results", async ({ page }) => {
  await open(page);
  await plan(page);
  await select(page);
  await page.evaluate(() => {
    Object.assign(window, { inspectionCancels: 0 });
    Blob.prototype.stream = () => new ReadableStream({ cancel() {
      Reflect.set(window, "inspectionCancels", Reflect.get(window, "inspectionCancels") + 1);
      return new Promise(() => {});
    } });
  });
  await page.getByRole("button", { name: "开始本地检查" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveText("正在核对生产事件");
  await page.getByRole("button", { name: "清除文件与结果" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "inspectionCancels"))).toBe(2);
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
});

test("runtime inspector: closing unmounts the active inspection and reopening starts empty", async ({ page }) => {
  await open(page);
  await plan(page);
  await select(page);
  await page.evaluate(() => { Blob.prototype.stream = () => new ReadableStream(); });
  await page.getByRole("button", { name: "开始本地检查" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveText("正在核对生产事件");
  await page.getByRole("button", { name: "关闭检查台" }).click();
  await expect(page.getByRole("heading", { name: "本地交接检查台" })).toHaveCount(0);
  await page.getByRole("button", { name: "检查本地交接包" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveCount(0);
});

test("runtime inspector: late plan reads cannot restore cleared or replaced selections", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if ((this as File).name === "slow.json") return new Promise<ArrayBuffer>((resolve) => {
        Object.assign(window, { finishInspectionPlan: () => { void original.call(this).then(resolve); } });
      });
      return original.call(this);
    };
  });
  await page.getByLabel("交接计划 JSON（最多 256 KiB）").setInputFiles(file("slow.json", JSON.stringify(inspectionFixture().plan)));
  await expect(page.getByText("正在读取本地计划…")).toBeVisible();
  await page.getByRole("button", { name: "清除文件与结果" }).click();
  const f = inspectionFixture();
  f.plan.consumer.run_id = "10000000-0000-4000-8000-000000009999";
  await plan(page, f.plan);
  await page.evaluate(() => Reflect.get(window, "finishInspectionPlan")());
  await expect(page.getByText(f.plan.consumer.run_id, { exact: true })).toBeVisible();
  await expect(page.getByTestId("inspection-result")).toHaveText("待选择文件");
});

test("runtime inspector: refresh loses local selections and unknown workspaces have no inspector", async ({ page }) => {
  await open(page);
  await plan(page);
  await select(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "检查本地交接包" })).toBeVisible();
  await page.getByRole("button", { name: "检查本地交接包" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveCount(0);
  await page.goto(studio + "/workspaces/unknown");
  await expect(page.getByRole("heading", { name: "无法打开这个工作区" })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查本地交接包" })).toHaveCount(0);
});

test("runtime inspector: file inspection makes no requests and persists no file content", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("status")).toContainText("本地 API 已连接");
  const requests: string[] = [];
  page.on("request", (r) => requests.push(`${r.method()} ${r.url()}`));
  const before = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await plan(page);
  await select(page);
  await page.getByRole("button", { name: "开始本地检查" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveText("字节校验通过（未授权执行）");
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual(before);
});

test("runtime inspector: mobile and contrast modes keep all controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await plan(page);
  await select(page);
  await page.getByRole("button", { name: "开始本地检查" }).click();
  await expect(page.getByTestId("inspection-result")).toHaveText("字节校验通过（未授权执行）");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.getByRole("button", { name: "清除文件与结果" })).toBeVisible();
  fs.mkdirSync("reports/screenshots", { recursive: true });
  await page.getByRole("region", { name: "本地交接检查台", exact: true }).screenshot({ path: "reports/screenshots/runtime-inspector-mobile.png" });
});
