/** Shared semantic palette. Values are local assets, never model/provider configuration. */
export const THEMES = ["light", "dark", "contrast"] as const;
export type Theme = (typeof THEMES)[number];
export type ThemePreference = Theme | "system";
export const THEME_LABELS: Readonly<Record<ThemePreference, string>> =
  Object.freeze({
    system: "跟随系统",
    light: "浅色",
    dark: "深色",
    contrast: "高对比",
  });
export const THEME_TOKENS = Object.freeze({
  light: Object.freeze({
    canvas: "#f5f6fa",
    surface: "#ffffff",
    raised: "#edf0f7",
    text: "#202538",
    muted: "#525d73",
    border: "#cdd3e0",
    controlBorder: "#727f97",
    accent: "#5540bc",
    onAccent: "#ffffff",
    accentSoft: "#eeeafb",
    info: "#234fbd",
    infoBg: "#eaf0ff",
    success: "#176244",
    successBg: "#e8f5ed",
    warning: "#7a4106",
    warningBg: "#fff1d6",
    danger: "#a12b38",
    dangerBg: "#ffedf0",
    neutral: "#4a566d",
    neutralBg: "#edf0f6",
    focus: "#3359c6",
  }),
  dark: Object.freeze({
    canvas: "#11141d",
    surface: "#191e2b",
    raised: "#232b3c",
    text: "#edf1fa",
    muted: "#adb8cd",
    border: "#414d65",
    controlBorder: "#8291ae",
    accent: "#c3b6ff",
    onAccent: "#19132f",
    accentSoft: "#302749",
    info: "#acc6ff",
    infoBg: "#182d4b",
    success: "#91e4b7",
    successBg: "#15392a",
    warning: "#ffdc99",
    warningBg: "#3b2d18",
    danger: "#ffb2bf",
    dangerBg: "#41232c",
    neutral: "#c2cbe0",
    neutralBg: "#293346",
    focus: "#e0d5ff",
  }),
  contrast: Object.freeze({
    canvas: "#000000",
    surface: "#000000",
    raised: "#121212",
    text: "#ffffff",
    muted: "#e0e0e0",
    border: "#c8c8c8",
    controlBorder: "#ffffff",
    accent: "#fff08a",
    onAccent: "#000000",
    accentSoft: "#242000",
    info: "#badbff",
    infoBg: "#001932",
    success: "#b0ffd0",
    successBg: "#002717",
    warning: "#ffe18e",
    warningBg: "#2c2100",
    danger: "#ffbcc8",
    dangerBg: "#32000c",
    neutral: "#ffffff",
    neutralBg: "#191919",
    focus: "#00ffff",
  }),
});
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && Object.hasOwn(THEME_LABELS, value);
}
export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): Theme {
  if (!isThemePreference(preference))
    throw new TypeError("Invalid theme preference");
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
export const UI_STATES = Object.freeze({
  loading: { label: "正在读取", tone: "info", icon: "clock" },
  empty: { label: "暂无内容", tone: "neutral", icon: "layers" },
  error: { label: "读取失败", tone: "danger", icon: "error" },
  forbidden: { label: "无权访问", tone: "danger", icon: "lock" },
  stale: { label: "版本已过期", tone: "warning", icon: "clock" },
  offline: { label: "已离线", tone: "neutral", icon: "offline" },
  running: { label: "运行中", tone: "info", icon: "play" },
  stopping: { label: "正在停止", tone: "warning", icon: "stop" },
  unknown: { label: "结果未知", tone: "neutral", icon: "help" },
  success: { label: "验证通过", tone: "success", icon: "check" },
} as const);
export type UIState = keyof typeof UI_STATES;
