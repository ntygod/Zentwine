import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { fixture, origin, query } from "./setup.mjs";
import {
  catalogApprovalPath,
  resourceObjectPath,
} from "../../packages/contracts/dist/index.js";
const legacy = "/org/local/workbench/settings";
async function browserTest(f, work) {
  const origins = [origin],
    app = f.app({ identity: { repository: f.repo, origins } }),
    calls = [],
    fault = { suffix: null, mode: "partial" };
  let browser;
  app.addHook("onRequest", async (r) => {
    if (r.url.startsWith("/api/"))
      calls.push({ path: r.url, method: r.method });
  });
  // The handler has already run against PostgreSQL. Drop only the transport response, never forge authorization.
  app.addHook("onSend", async (r, reply, payload) => {
    if (
      fault.suffix &&
      r.method === "POST" &&
      r.url.endsWith(fault.suffix) &&
      reply.statusCode === 200
    ) {
      fault.suffix = null;
      if (fault.mode === "empty") reply.raw.destroy();
      else {
        // Headers distinguish an interrupted body from a reused-socket retry before any response.
        assert.equal(typeof payload, "string");
        const bytes = Buffer.from(payload);
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(bytes.length),
          Connection: "close",
        });
        reply.raw.end(bytes.subarray(0, Math.min(32, bytes.length - 1)));
      }
    }
    return payload;
  });
  for (const path of [
    "/org/:org/workbench",
    "/org/:org/workbench/:view",
    "/org/:org/workbench/objects/:id",
    "/org/:org/workbench/objects/:id/rename",
    "/org/:org/workbench/approvals/:id",
  ])
    app.get(path, async (_r, reply) =>
      reply
        .type("text/html")
        .send(await fs.readFile("apps/workbench/dist/index.html", "utf8")),
    );
  app.get("/assets/:file", async (r, reply) => {
    if (!/^index-[a-zA-Z0-9_-]+\.(js|css)$/.test(r.params.file))
      return reply.code(404).send();
    return reply
      .type(
        r.params.file.endsWith(".js") ? "application/javascript" : "text/css",
      )
      .send(await fs.readFile("apps/workbench/dist/assets/" + r.params.file));
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = "http://127.0.0.1:" + app.server.address().port;
    origins.push(base);
    browser = await chromium.launch({ headless: true });
    await fs.mkdir("reports/catalog-approval-ui", { recursive: true });
    await work({ browser, base, calls, fault });
  } finally {
    await browser?.close();
    await app.close();
  }
}
async function login(f, browser, base, who = f.alice) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  await context.addInitScript(() => {
    // Observe application calls, never change their arguments or authorization responses.
    const calls = [];
    Object.defineProperty(window, "__catalogFetchWrites", { value: calls });
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (
        typeof input === "string" &&
        init?.method === "POST" &&
        input.includes("/approvals")
      )
        calls.push(input);
      return original(input, init);
    };
  });
  await page.goto(base + legacy);
  await page
    .getByLabel("一次性登录票据", { exact: true })
    .fill(await f.ticket(who));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeEnabled();
  return { page, context };
}
async function open(f, page, base, mode, id, org = f.orgA) {
  await page.goto(base + catalogApprovalPath(org, mode, id));
  await expect(
    page.getByRole("button", { name: "确认切换到链接组织", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "确认切换到链接组织", exact: true })
    .click();
}
async function inspect(page) {
  await expect(
    page.getByRole("region", { name: "精确审批范围", exact: true }),
  ).toBeVisible();
}
async function action(page, name) {
  await page
    .getByRole("button", { name: "打开目录操作确认", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "确认目录操作",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name, exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("checkbox", {
      name: "已核对目标版本、名称和责任人",
      exact: true,
    })
    .check();
  await dialog.getByRole("button", { name, exact: true }).click();
}
const writes = (calls) =>
  calls.filter((c) => c.method === "POST" && c.path.includes("/approvals"));
const dbResource = async (f) =>
  (
    await query(
      f.adminPool,
      "SELECT display_name,object_version FROM zentwine_policy.resources WHERE id=$1",
      [f.a.id],
    )
  ).rows[0];
test("catalog approval browser PG: two independent users request approve and explicitly execute one rename", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const alice = await login(f, browser, base);
      await alice.page.goto(base + resourceObjectPath(f.orgA, f.a.id));
      await alice.page
        .getByRole("button", { name: "确认切换组织", exact: true })
        .click();
      await alice.page
        .getByRole("link", { name: "申请目录改名", exact: true })
        .click();
      await expect(
        alice.page.getByRole("form", { name: "新目录改名申请" }),
      ).toBeVisible();
      await alice.page
        .getByRole("textbox", { name: "拟登记的新名称" })
        .fill("共同确认的新目录名");
      await alice.page
        .getByRole("checkbox", { name: "仅申请改名，必须经另一名负责人审核" })
        .check();
      await alice.page
        .getByRole("button", { name: "提交目录改名申请", exact: true })
        .click();
      await inspect(alice.page);
      const id = new URL(alice.page.url()).pathname.split("/").at(-1);
      assert.notEqual(id, "rename");
      const row = (
        await query(
          f.adminPool,
          "SELECT state,binding FROM zentwine_approvals.requests WHERE id=$1",
          [id],
        )
      ).rows[0];
      assert.equal(row.state, "pending");
      assert.equal(row.binding.display_name, "共同确认的新目录名");
      assert.equal((await dbResource(f)).display_name, f.a.display_name);
      await alice.page
        .getByRole("button", { name: "打开目录操作确认" })
        .click();
      await expect(
        alice.page.getByRole("button", { name: "批准此目录改名", exact: true }),
      ).toHaveCount(0);
      await alice.page.keyboard.press("Escape");
      const bob = await login(f, browser, base, f.bob);
      await open(f, bob.page, base, "inspect", id);
      await inspect(bob.page);
      await bob.page.screenshot({
        path: "reports/catalog-approval-ui/review-light.png",
        fullPage: true,
      });
      await action(bob.page, "批准此目录改名");
      await expect(
        bob.page.getByText("已记录批准，尚未执行", { exact: true }),
      ).toBeVisible();
      assert.equal((await dbResource(f)).display_name, f.a.display_name);
      await alice.page
        .getByRole("button", { name: "重新核验结果", exact: true })
        .click();
      await inspect(alice.page);
      await action(alice.page, "执行已批准改名");
      await expect(
        alice.page.getByRole("region", { name: "已提交执行回执" }),
      ).toBeVisible();
      assert.deepEqual(await dbResource(f), {
        display_name: "共同确认的新目录名",
        object_version: f.a.object_version + 1,
      });
      assert.deepEqual(
        writes(calls).map((c) => c.path.split("/").at(-1)),
        ["approvals", "decide", "permit", "execute"],
      );
      const count = writes(calls).length;
      await alice.page.reload();
      await inspect(alice.page);
      assert.equal(writes(calls).length, count);
      await alice.page.screenshot({
        path: "reports/catalog-approval-ui/receipt.png",
        fullPage: true,
      });
      for (const page of [alice.page, bob.page])
        assert.equal(
          await page.evaluate(
            () =>
              Object.keys(localStorage).length +
              Object.keys(sessionStorage).length,
          ),
          0,
        );
    }),
  ));
test("catalog approval browser PG: reject records independent reviewer without changing resource", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const a = await f.propose(),
        { page } = await login(f, browser, base, f.bob);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      await action(page, "拒绝此目录改名");
      await expect(
        page.getByText("已拒绝，不会执行", { exact: true }),
      ).toBeVisible();
      assert.equal(
        (await f.approvals.inspect(f.owner.scope, a.id)).decision.actor_id,
        f.bob,
      );
      assert.equal((await dbResource(f)).display_name, f.a.display_name);
      await page.reload();
      await inspect(page);
      assert.equal(writes(calls).length, 1);
    }),
  ));
test("catalog approval browser PG: stale resource version refuses a previously opened approval", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const a = await f.propose(),
        { page } = await login(f, browser, base, f.bob);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      await query(
        f.adminPool,
        "UPDATE zentwine_policy.resources SET object_version=object_version+1 WHERE id=$1",
        [f.a.id],
      );
      await action(page, "批准此目录改名");
      await expect(page.getByRole("alert")).toContainText(
        "版本或组织上下文已变化",
      );
      await expect(
        page.getByRole("region", { name: "精确审批范围" }),
      ).toHaveCount(0);
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT * FROM zentwine_approvals.decisions WHERE approval_id=$1",
            [a.id],
          )
        ).rows.length,
        0,
      );
    }),
  ));
test("catalog approval browser PG: server expiry rejects consent and preserves the original name", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const a = await f.propose(),
        { page } = await login(f, browser, base, f.bob);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      await query(
        f.adminPool,
        "UPDATE zentwine_approvals.requests SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
        [a.id],
      );
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT expires_at<clock_timestamp() AND expires_at>created_at AND expires_at<=created_at+interval '15 minutes' AS expired_valid_fixture FROM zentwine_approvals.requests WHERE id=$1",
            [a.id],
          )
        ).rows[0].expired_valid_fixture,
        true,
      );
      await action(page, "批准此目录改名");
      await expect(page.getByRole("alert")).toContainText("有效期或操作规则");
      assert.equal((await dbResource(f)).display_name, f.a.display_name);
    }),
  ));
test("catalog approval browser PG: guest and foreign-organization locators reveal no binding", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const a = await f.propose();
      await f.accept(await f.invite());
      const guest = await login(f, browser, base, f.charlie);
      await open(f, guest.page, base, "inspect", a.id);
      await expect(guest.page.getByRole("alert")).toBeVisible();
      await expect(
        guest.page.getByRole("region", { name: "精确审批范围" }),
      ).toHaveCount(0);
      const auth = (
        await guest.context.request.get(base + "/api/v1/auth/session")
      ).json();
      const session = await auth;
      const direct = await guest.context.request.get(
        base + `/api/v1/orgs/${f.orgA}/approvals/${a.id}`,
        {
          headers: {
            "x-zentwine-context-version": String(
              session.session.context_version,
            ),
          },
        },
      );
      assert.equal(direct.status(), 404);
      assert.ok(!(await direct.text()).includes(a.content_hash));
      const alice = await login(f, browser, base);
      await open(f, alice.page, base, "inspect", a.id, f.orgB);
      await expect(alice.page.getByRole("alert")).toBeVisible();
      await expect(
        alice.page.getByRole("region", { name: "精确审批范围" }),
      ).toHaveCount(0);
      assert.equal(writes(calls).length, 0);
    }),
  ));
test("catalog approval browser PG: lost permit response does not execute or reissue and permits explicit revocation", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls, fault }) => {
      const a = await f.approve(await f.propose()),
        { page } = await login(f, browser, base);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      fault.suffix = "/permit";
      await action(page, "执行已批准改名");
      await expect(page.getByRole("alert")).toContainText("提交结果尚未确认");
      await page
        .getByRole("button", { name: "重新核验结果", exact: true })
        .click();
      await inspect(page);
      await expect(
        page.getByText("许可已签发，执行结果须核验", { exact: true }),
      ).toBeVisible();
      assert.equal(
        writes(calls).filter((c) => c.path.endsWith("/execute")).length,
        0,
      );
      await action(page, "撤销此申请");
      await expect(
        page.getByText("已撤销，不会执行", { exact: true }),
      ).toBeVisible();
      assert.equal((await dbResource(f)).display_name, f.a.display_name);
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT * FROM zentwine_approvals.permits WHERE approval_id=$1",
            [a.id],
          )
        ).rows.length,
        1,
      );
    }),
  ));
test("catalog approval browser PG: lost execution response reconciles the committed receipt without re-execution", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls, fault }) => {
      const a = await f.approve(await f.propose()),
        { page } = await login(f, browser, base);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      fault.suffix = "/execute";
      await action(page, "执行已批准改名");
      await expect(page.getByRole("alert")).toContainText("提交结果尚未确认");
      await page
        .getByRole("button", { name: "重新核验结果", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "已提交执行回执" }),
      ).toBeVisible();
      assert.deepEqual(await dbResource(f), {
        display_name: a.binding.display_name,
        object_version: a.binding.resource_version + 1,
      });
      assert.equal(
        writes(calls).filter((c) => c.path.endsWith("/execute")).length,
        1,
      );
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT * FROM zentwine_approvals.receipts WHERE approval_id=$1",
            [a.id],
          )
        ).rows.length,
        1,
      );
    }),
  ));
test("catalog approval browser PG: real decision storage failure rolls back and requires a new explicit confirmation", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const a = await f.propose(),
        { page } = await login(f, browser, base, f.bob);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      await query(
        f.adminPool,
        `REVOKE INSERT ON zentwine_approvals.decisions FROM "${f.appConfig.user}"`,
      );
      await action(page, "批准此目录改名");
      await expect(page.getByRole("alert")).toBeVisible();
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT state FROM zentwine_approvals.requests WHERE id=$1",
            [a.id],
          )
        ).rows[0].state,
        "pending",
      );
      await query(
        f.adminPool,
        `GRANT INSERT ON zentwine_approvals.decisions TO "${f.appConfig.user}"`,
      );
      await page
        .getByRole("button", { name: "重新核验结果", exact: true })
        .click();
      await inspect(page);
      assert.equal(writes(calls).length, 1);
      await action(page, "批准此目录改名");
      await expect(
        page.getByText("已记录批准，尚未执行", { exact: true }),
      ).toBeVisible();
    }),
  ));
test("catalog approval browser PG: same-session organization change clears open confirmation and never posts old decision", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const a = await f.propose(),
        { page, context } = await login(f, browser, base, f.bob);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      await page.getByRole("button", { name: "打开目录操作确认" }).click();
      const second = await context.newPage();
      await second.goto(base + legacy);
      await expect(
        second.getByLabel("当前组织", { exact: true }),
      ).toBeEnabled();
      await second.getByLabel("当前组织", { exact: true }).selectOption(f.orgB);
      await expect(
        second.getByRole("button", { name: "刷新状态", exact: true }),
      ).toBeEnabled();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByRole("heading", { name: "链接指向另一组织", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "精确审批范围" }),
      ).toHaveCount(0);
      assert.equal(writes(calls).length, 0);
    }),
  ));
test("catalog approval browser PG: offline invalidation removes draft name instead of restoring stale input", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const { page, context } = await login(f, browser, base);
      await open(f, page, base, "request", f.a.id);
      await page
        .getByRole("textbox", { name: "拟登记的新名称" })
        .fill("未提交的名称");
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(
        page.getByRole("heading", { name: "离线或页面已暂停" }),
      ).toBeVisible();
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(
        page.getByRole("textbox", { name: "拟登记的新名称" }),
      ).toHaveValue("");
      assert.equal(writes(calls).length, 0);
    }),
  ));
test("catalog approval browser PG: three themes narrow-screen and keyboard confirmation preserve consent boundaries", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const a = await f.propose(),
        { page } = await login(f, browser, base, f.bob);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      for (const theme of ["light", "dark", "contrast"]) {
        await page.getByRole("combobox", { name: "外观" }).selectOption(theme);
        await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
          "data-zt-theme",
          theme,
        );
        await page.screenshot({
          path: `reports/catalog-approval-ui/approval-${theme}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.getByRole("button", { name: "打开目录操作确认" }).click();
      const dialog = page.getByRole("dialog", { name: "确认目录操作" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "批准此目录改名", exact: true }),
      ).toBeDisabled();
      for (const key of ["Tab", "Shift+Tab", "Tab", "Tab"]) {
        await page.keyboard.press(key);
        assert.ok(
          await dialog.evaluate((d) => d.contains(document.activeElement)),
        );
      }
      await page.screenshot({
        path: "reports/catalog-approval-ui/confirmation-mobile.png",
        fullPage: true,
      });
      await dialog.getByRole("checkbox").check();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "打开目录操作确认" }),
      ).toBeFocused();
      await page.getByRole("button", { name: "打开目录操作确认" }).click();
      await expect(
        page.getByRole("dialog").getByRole("checkbox"),
      ).not.toBeChecked();
      assert.equal(writes(calls).length, 0);
    }),
  ));
test("catalog approval browser PG: unknown approval ID returns no metadata or command affordances", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      const { page } = await login(f, browser, base);
      await open(f, page, base, "inspect", randomUUID());
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(
        page.getByRole("region", { name: "精确审批范围" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "打开目录操作确认" }),
      ).toHaveCount(0);
    }),
  ));

test("catalog approval browser PG: pre-header disconnect may retransmit HTTP but never application intent or database effect", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls, fault }) => {
      const a = await f.approve(await f.propose()),
        { page } = await login(f, browser, base);
      await open(f, page, base, "inspect", a.id);
      await inspect(page);
      fault.mode = "empty";
      fault.suffix = "/execute";
      await action(page, "执行已批准改名");
      await expect(page.getByRole("alert")).toContainText("提交结果尚未确认");
      await page
        .getByRole("button", { name: "重新核验结果", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "已提交执行回执" }),
      ).toBeVisible();
      const applicationCalls = await page.evaluate(
        () =>
          window.__catalogFetchWrites.filter((p) => p.endsWith("/execute"))
            .length,
      );
      const httpCalls = writes(calls).filter((c) =>
        c.path.endsWith("/execute"),
      ).length;
      const receiptCount = (
        await query(
          f.adminPool,
          "SELECT * FROM zentwine_approvals.receipts WHERE approval_id=$1",
          [a.id],
        )
      ).rows.length;
      const state = (await f.approvals.inspect(f.owner.scope, a.id)).state;
      assert.equal(applicationCalls, 1);
      assert.ok(httpCalls >= applicationCalls);
      assert.equal(receiptCount, 1);
      assert.equal(state, "consumed");
      assert.deepEqual(await dbResource(f), {
        display_name: a.binding.display_name,
        object_version: a.binding.resource_version + 1,
      });
      await fs.writeFile(
        "reports/catalog-approval-ui/transport-reconciliation.json",
        JSON.stringify(
          {
            scope:
              "real Chromium and PostgreSQL, post-commit pre-header disconnect",
            browser: browser.version(),
            application_execute_calls: applicationCalls,
            http_execute_requests: httpCalls,
            execution_receipts: receiptCount,
            state,
            single_resource_version_increment: true,
          },
          null,
          2,
        ),
      );
    }),
  ));
