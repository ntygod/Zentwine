import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  THEMES,
  THEME_TOKENS,
  THEME_LABELS,
  UI_STATES,
  isThemePreference,
  resolveTheme,
} from "../packages/ui/dist/tokens.js";
// Independent WCAG relative-luminance calculation, without rounding the acceptance threshold.
const luminance = (hex) => {
  const c = hex
    .slice(1)
    .match(/../g)
    .map((part) => parseInt(part, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
};
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) /
  (Math.min(luminance(a), luminance(b)) + 0.05);
test("ui tokens: three complete immutable palettes use identical semantic keys", () => {
  assert.deepEqual(THEMES, ["light", "dark", "contrast"]);
  assert.ok(Object.isFrozen(THEME_TOKENS));
  for (const theme of THEMES) {
    assert.deepEqual(
      Object.keys(THEME_TOKENS[theme]),
      Object.keys(THEME_TOKENS.light),
    );
    assert.ok(Object.isFrozen(THEME_TOKENS[theme]));
    assert.ok(
      Object.values(THEME_TOKENS[theme]).every((s) => /^#[0-9a-f]{6}$/.test(s)),
    );
  }
});
for (const theme of THEMES) {
  test(`ui tokens: ${theme} text and state pairings meet the documented contrast floor`, () => {
    const t = THEME_TOKENS[theme];
    const pairs = [
      ["text", "canvas"],
      ["text", "surface"],
      ["text", "raised"],
      ["muted", "canvas"],
      ["muted", "surface"],
      ["muted", "raised"],
      ["muted", "accentSoft"],
      ["accent", "canvas"],
      ["accent", "surface"],
      ["accent", "accentSoft"],
      ["onAccent", "accent"],
      ["info", "infoBg"],
      ["success", "successBg"],
      ["warning", "warningBg"],
      ["danger", "dangerBg"],
      ["neutral", "neutralBg"],
    ];
    for (const [fg, bg] of pairs)
      assert.ok(
        contrast(t[fg], t[bg]) >= (theme === "contrast" ? 7 : 4.5),
        `${theme} ${fg}/${bg}: ${contrast(t[fg], t[bg])}`,
      );
  });
  test(`ui tokens: ${theme} field boundaries and keyboard focus remain visible`, () => {
    const t = THEME_TOKENS[theme];
    for (const fg of ["controlBorder", "focus"])
      for (const bg of ["canvas", "surface", "raised"])
        assert.ok(contrast(t[fg], t[bg]) >= 3, `${theme} ${fg}/${bg}`);
  });
}
test("ui theme: system follows media while explicit choices do not", () => {
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("system", true), "dark");
  for (const theme of THEMES)
    for (const dark of [false, true])
      assert.equal(resolveTheme(theme, dark), theme);
});
test("ui theme: unknown and inherited preferences are rejected", () => {
  for (const value of [
    null,
    undefined,
    {},
    "__proto__",
    "constructor",
    "LIGHT",
    "",
    "automatic",
  ]) {
    assert.equal(isThemePreference(value), false);
    assert.throws(() => resolveTheme(value, false), TypeError);
  }
  for (const value of Object.keys(THEME_LABELS))
    assert.equal(isThemePreference(value), true);
});
test("ui states: every state has words and distinct run stop unknown symbols", () => {
  assert.equal(Object.keys(UI_STATES).length, 10);
  assert.equal(new Set(Object.values(UI_STATES).map((s) => s.label)).size, 10);
  for (const s of Object.values(UI_STATES)) {
    assert.ok(s.label.length > 1);
    assert.ok(Object.hasOwn(THEME_TOKENS.light, s.tone));
    assert.ok(Object.hasOwn(THEME_TOKENS.light, s.tone + "Bg"));
  }
  assert.equal(
    new Set(["running", "stopping", "unknown"].map((s) => UI_STATES[s].icon))
      .size,
    3,
  );
});
test("ui styles: existing shells and organization forms use shared palette rather than fixed hex colors", () => {
  for (const file of [
    "packages/ui/src/styles.css",
    "apps/workbench/src/organization.css",
  ]) {
    const css = fs.readFileSync(file, "utf8");
    assert.ok(!/#[a-f0-9]{3,8}\b/i.test(css));
    assert.ok(css.includes("var(--zt-"));
  }
});
