import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { fixture, origin, query } from "./setup.mjs";
import {
  approvalInboxPath,
  catalogApprovalPath,
  organizationWorkbenchPath,
} from "../../packages/contracts/dist/index.js";
import { guard } from "../approvals/setup.mjs";
async function browserTest(f, work) {
  const origins = [origin],
    app = f.app({ identity: { repository: f.repo, origins } }),
    calls = [];
  let browser, detailHook;
  app.addHook("onRequest", async (r) => {
    if (r.url.startsWith("/api/"))
      calls.push({ path: r.url, method: r.method });
  });
  for (const path of [
    "/org/:org/workbench",
    "/org/:org/workbench/:view",
    "/org/:org/workbench/approvals/:id",
    "/org/:org/workbench/objects/:id/rename",
  ])
    app.get(path, async (r, reply) => {
      if (path === "/org/:org/workbench/approvals/:id")
        await detailHook?.(r.params.id);
      return reply
        .type("text/html")
        .send(await fs.readFile("apps/workbench/dist/index.html", "utf8"));
    });
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
    await fs.mkdir("reports/approval-inbox-ui", { recursive: true });
    await work({
      browser,
      base,
      calls,
      holdDetail: (hook) => {
        detailHook = hook;
      },
    });
  } finally {
    await browser?.close();
    await app.close();
  }
}
async function login(f, browser, base, human = f.alice) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  await page.goto(base + "/org/local/workbench/settings");
  await page
    .getByLabel("一次性登录票据", { exact: true })
    .fill(await f.ticket(human));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeEnabled();
  return { context, page };
}
async function open(f, page, base) {
  await page.goto(base + approvalInboxPath(f.orgA));
  await page
    .getByRole("button", { name: "确认切换到链接组织", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "可见审批记录", exact: true }),
  ).toBeVisible();
}
const records = (page) =>
  page
    .getByRole("list", { name: "审批记录列表", exact: true })
    .getByRole("listitem");
const writes = (calls) =>
  calls.filter((c) => c.path.includes("/approvals") && c.method !== "GET");
async function filter(page, lane, state) {
  await page
    .getByRole("combobox", { name: "申请范围", exact: true })
    .selectOption(lane);
  await page
    .getByRole("combobox", { name: "记录状态", exact: true })
    .selectOption(state);
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "可见审批记录", exact: true }),
  ).toBeVisible();
}
test("inbox browser PG: workbench discovery leads to exact B1 detail without approving or executing", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const a = await f.propose({ display_name: "可被找到的目录改名" }),
        { page } = await login(f, browser, base);
      await page.goto(base + organizationWorkbenchPath(f.orgA));
      await page
        .getByRole("button", { name: "确认切换组织", exact: true })
        .click();
      await page
        .getByRole("link", { name: "目录审批工作台", exact: true })
        .click();
      await expect(records(page)).toHaveCount(1);
      await expect(
        records(page).getByRole("heading", {
          name: "拟登记名称：可被找到的目录改名",
        }),
      ).toBeVisible();
      await records(page)
        .getByRole("link", { name: "核对审批详情", exact: true })
        .click();
      await expect(page).toHaveURL(
        base + catalogApprovalPath(f.orgA, "inspect", a.id),
      );
      await expect(
        page.getByRole("region", { name: "精确审批范围", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "目录审批工作台", exact: true })
        .click();
      await expect(records(page)).toHaveCount(1);
      assert.equal(writes(calls).length, 0);
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
    }),
  ));
test("inbox browser PG: independent owner finds colleague pending requests and opens guarded review", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const a = await f.propose({ display_name: "等待他人审核" });
      const { page } = await login(f, browser, base, f.bob);
      await open(f, page, base);
      await expect(
        page.getByText("当前筛选没有可见审批记录；不代表组织中没有其他申请。", {
          exact: true,
        }),
      ).toBeVisible();
      await filter(page, "review", "pending");
      await expect(records(page)).toHaveCount(1);
      await expect(
        records(page).getByText(f.alice, { exact: true }),
      ).toBeVisible();
      await records(page).getByRole("link", { name: "核对审批详情" }).click();
      await expect(page).toHaveURL(
        base + catalogApprovalPath(f.orgA, "inspect", a.id),
      );
      await expect(
        page.getByRole("button", { name: "打开目录操作确认" }),
      ).toBeVisible();
      assert.equal(writes(calls).length, 0);
    }),
  ));
test("inbox browser PG: pagination replaces rows and refresh resets the creation boundary", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const created = [];
      for (let i = 0; i < 21; i++)
        created.push(await f.propose({ display_name: "分页申请 " + i }));
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      await expect(records(page)).toHaveCount(20);
      await page
        .getByRole("button", { name: "下一页审批", exact: true })
        .click();
      await expect(records(page)).toHaveCount(1);
      await expect(records(page).getByRole("link")).toHaveAttribute(
        "href",
        catalogApprovalPath(f.orgA, "inspect", created[0].id),
      );
      await expect(
        page.getByRole("button", { name: "下一页审批" }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "刷新审批列表" }).click();
      await expect(records(page)).toHaveCount(20);
      assert.equal(writes(calls).length, 0);
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
test("inbox browser PG: restricted colleague requests and guest direct requests reveal no metadata", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const hidden = await f.registerResource({
        visibility: "restricted",
        owner_human_id: f.alice,
      });
      await f.propose({
        resource_id: hidden.id,
        display_name: "不可泄漏的申请",
      });
      const bob = await login(f, browser, base, f.bob);
      await open(f, bob.page, base);
      await filter(bob.page, "review", "all");
      await expect(
        bob.page.getByText("不可泄漏的申请", { exact: false }),
      ).toHaveCount(0);
      const guest = await f.accept(await f.invite()),
        visitor = await login(f, browser, base, f.charlie);
      await visitor.page.goto(base + approvalInboxPath(f.orgA));
      await visitor.page
        .getByRole("button", { name: "确认切换到链接组织" })
        .click();
      await expect(visitor.page.getByRole("alert")).toBeVisible();
      await expect(records(visitor.page)).toHaveCount(0);
      const response = await visitor.context.request.get(
        base + `/api/v1/orgs/${f.orgA}/approvals`,
        {
          headers: {
            cookie: guest.cookie,
            "x-zentwine-context-version": String(guest.scope.context_version),
          },
        },
      );
      assert.equal(response.status(), 404);
      assert.ok(!(await response.text()).includes("不可泄漏"));
      assert.equal(writes(calls).length, 0);
    }),
  ));
test("inbox browser PG: organization revocation and cross-window switching clear discovered records", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base }) => {
      await f.propose({ display_name: "旧上下文记录" });
      const { page, context } = await login(f, browser, base);
      await open(f, page, base);
      await expect(records(page)).toHaveCount(1);
      const other = await context.newPage();
      await other.goto(base + organizationWorkbenchPath(f.orgB));
      await other.getByRole("button", { name: "确认切换组织" }).click();
      await expect(
        other.getByRole("navigation", { name: "组织导航" }),
      ).toBeVisible();
      await page.bringToFront();
      // Headless tabs do not consistently synthesize OS focus; exercise the real focus handler explicitly.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByRole("button", { name: "确认切换到链接组织" }),
      ).toBeVisible();
      await expect(records(page)).toHaveCount(0);
      const bob = await login(f, browser, base, f.bob);
      await open(f, bob.page, base);
      await filter(bob.page, "review", "all");
      await expect(records(bob.page)).toHaveCount(1);
      await f.organizations.revokeOrganizationSessions(f.owner.scope, f.bob);
      await bob.page.getByRole("button", { name: "刷新审批列表" }).click();
      await expect(bob.page.getByRole("alert")).toBeVisible();
      await expect(records(bob.page)).toHaveCount(0);
    }),
  ));
test("inbox browser PG: storage read failure and offline state clear rows then recover through GET", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      await f.propose();
      const { page, context } = await login(f, browser, base);
      await open(f, page, base);
      await expect(records(page)).toHaveCount(1);
      await query(
        f.adminPool,
        `REVOKE SELECT ON zentwine_approvals.events FROM "${f.appConfig.user}"`,
      );
      await page.getByRole("button", { name: "刷新审批列表" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(records(page)).toHaveCount(0);
      await query(
        f.adminPool,
        `GRANT SELECT ON zentwine_approvals.events TO "${f.appConfig.user}"`,
      );
      await page.getByRole("button", { name: "从第一页重新读取" }).click();
      await expect(records(page)).toHaveCount(1);
      await context.setOffline(true);
      await expect(
        page.getByRole("heading", { name: "离线或页面已暂停" }),
      ).toBeVisible();
      await expect(records(page)).toHaveCount(0);
      await context.setOffline(false);
      await expect(records(page)).toHaveCount(1);
      assert.equal(writes(calls).length, 0);
    }),
  ));
test("inbox browser PG: expired unfinished requests are separated from terminal history", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      const expired = await f.propose({ display_name: "已过期未处理" }),
        rejected = await f.propose({ display_name: "已拒绝的历史" });
      await f.approvals.decide(
        f.reviewer.scope,
        rejected.id,
        guard(rejected),
        "reject",
      );
      await query(
        f.adminPool,
        "UPDATE zentwine_approvals.requests SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])",
        [[expired.id, rejected.id]],
      );
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      await filter(page, "mine", "expired");
      await expect(records(page)).toHaveCount(1);
      await expect(
        records(page).getByRole("heading", {
          name: "拟登记名称：已过期未处理",
        }),
      ).toBeVisible();
      await filter(page, "mine", "rejected");
      await expect(records(page)).toHaveCount(1);
      await expect(
        records(page).getByText("已拒绝", { exact: true }),
      ).toBeVisible();
      assert.equal(writes(calls).length, 0);
    }),
  ));
test("inbox browser PG: keyboard filters and three themes remain usable at narrow widths", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls }) => {
      await f.propose({
        display_name: "团队共同审核的长名称与 English title 2026",
      });
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      const status = page.getByRole("combobox", {
        name: "记录状态",
        exact: true,
      });
      await status.focus();
      await page.keyboard.press("p");
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "应用筛选", exact: true }),
      ).toBeFocused();
      for (const theme of ["light", "dark", "contrast"]) {
        await page.getByRole("combobox", { name: "外观" }).selectOption(theme);
        await expect(page.locator("[data-zt-theme]")).toHaveAttribute(
          "data-zt-theme",
          theme,
        );
        await page.screenshot({
          path: `reports/approval-inbox-ui/inbox-${theme}.png`,
          fullPage: true,
        });
      }
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const columns = await page
          .locator(".inbox-facts")
          .evaluate(
            (el) =>
              getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/)
                .length,
          );
        assert.equal(columns, 1, "Narrow facts must use one full-width column");
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
      }
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "24px";
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: "reports/approval-inbox-ui/inbox-mobile.png",
        fullPage: true,
      });
      await page.emulateMedia({ forcedColors: "active" });
      await expect(records(page).getByRole("link")).toBeVisible();
      assert.equal(writes(calls).length, 0);
    }),
  ));

test("inbox browser PG: recorded request never renders decision detail under the old request URL", () =>
  fixture((f) =>
    browserTest(f, async ({ browser, base, calls, holdDetail }) => {
      const { page } = await login(f, browser, base);
      await open(f, page, base);
      await page.goto(base + catalogApprovalPath(f.orgA, "request", f.a.id));
      await expect(
        page.getByRole("form", { name: "新目录改名申请" }),
      ).toBeVisible();
      let release, reached, capture;
      const waiting = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise((resolve) => {
        reached = resolve;
      });
      const observed = new Promise((resolve) => {
        capture = resolve;
      });
      // Observe the old document before navigation: evaluating after a pending navigation can await the new document.
      await page.exposeFunction("captureCatalogTransition", capture);
      await page.evaluate(() => {
        const observer = new MutationObserver(() => {
          const detailed =
            document.querySelector('[aria-label="精确审批范围"]') !== null;
          const recorded =
            document.body.textContent.includes("申请已记录，正在打开详情");
          if (!detailed && !recorded) return;
          observer.disconnect();
          void window.captureCatalogTransition({
            detailed,
            decision:
              document.querySelector("#approval-decision-title") !== null,
            recorded,
            pathname: window.location.pathname,
            target: [...document.querySelectorAll("a")]
              .find((a) => a.textContent.trim() === "前往已记录的审批")
              ?.getAttribute("href"),
          });
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      holdDetail(async (id) => {
        reached(id);
        await waiting;
      });
      await page
        .getByRole("textbox", { name: "拟登记的新名称" })
        .fill("先完成导航再展示决策");
      await page
        .getByRole("checkbox", { name: "仅申请改名，必须经另一名负责人审核" })
        .check();
      const clicking = page
        .getByRole("button", { name: "提交目录改名申请", exact: true })
        .click();
      clicking.catch(() => {});
      let approval, timer;
      try {
        const timeout = new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Navigation observation did not complete")),
            5000,
          );
        });
        const [id, displayed] = await Promise.race([
          Promise.all([started, observed]),
          timeout,
        ]);
        approval = id;
        assert.notEqual(approval, "rename");
        assert.equal(
          displayed.pathname,
          catalogApprovalPath(f.orgA, "request", f.a.id),
        );
        assert.equal(displayed.detailed, false);
        assert.equal(displayed.decision, false);
        assert.equal(displayed.recorded, true);
        assert.equal(
          displayed.target,
          catalogApprovalPath(f.orgA, "inspect", approval),
        );
      } finally {
        clearTimeout(timer);
        release();
        holdDetail(null);
        await clicking;
      }
      await expect(page).toHaveURL(
        base + catalogApprovalPath(f.orgA, "inspect", approval),
      );
      await expect(
        page.getByRole("region", { name: "精确审批范围", exact: true }),
      ).toBeVisible();
      assert.equal(writes(calls).length, 1);
      assert.equal(
        (
          await query(
            f.adminPool,
            "SELECT state FROM zentwine_approvals.requests WHERE id=$1",
            [approval],
          )
        ).rows[0].state,
        "pending",
      );
    }),
  ));
