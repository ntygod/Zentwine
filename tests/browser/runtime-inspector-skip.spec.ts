import { test, expect } from "./fixtures.js";
const studio = "http://127.0.0.1:5174/org/local/studio";

test("runtime inspector: offscreen skip link is clipped without losing keyboard access", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(studio);
  const skip = page.getByRole("link", { name: "跳转到开发区域" });
  const clip = () => skip.evaluate((el) => getComputedStyle(el).clipPath);
  expect(await clip()).toBe("inset(50%)");
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  expect(await clip()).toBe("none");
  expect(await skip.evaluate((el) => el.getBoundingClientRect().top)).toBe(8);
  await page.getByRole("button", { name: "检查本地交接包" }).click();
  expect(await clip()).toBe("inset(50%)");
  await expect(
    page.getByRole("heading", { name: "本地交接检查台" }),
  ).toBeVisible();
});
