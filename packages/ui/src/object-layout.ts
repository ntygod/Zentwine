import { useState } from "react";
import {
  DEFAULT_OBJECT_LAYOUT,
  readObjectLayout,
  saveObjectLayout,
  resetObjectLayout,
  type ObjectLayout,
} from "@zentwine/client";
const storage = () => window.localStorage;
/** Presentation persistence is opt-in, never identity or resource caching. */
export function useObjectLayout() {
  const [preference, setPreference] = useState(() => readObjectLayout(storage));
  const [notice, setNotice] = useState("");
  const { layout } = preference;
  return {
    layout,
    message:
      notice ||
      (preference.status === "saved"
        ? "已恢复此浏览器保存的布局。"
        : preference.status === "unavailable"
          ? "布局偏好不可用，使用默认布局；没有读取业务缓存。"
          : "默认不保存。手动保存仅影响此浏览器外观，不含业务或权限数据。"),
    change(next: ObjectLayout) {
      setPreference({ layout: next, status: "default" });
      setNotice("布局仅在当前页面生效，尚未保存。");
    },
    save() {
      const saved = saveObjectLayout(storage, layout);
      setPreference({ layout, status: saved ? "saved" : "unavailable" });
      setNotice(
        saved
          ? "布局已保存到此浏览器；仅包含密度和侧栏开关。"
          : "浏览器存储不可用；布局仅在当前页面生效。",
      );
    },
    reset() {
      const reset = resetObjectLayout(storage);
      setPreference({
        layout: DEFAULT_OBJECT_LAYOUT,
        status: reset ? "default" : "unavailable",
      });
      setNotice(
        reset
          ? "已恢复默认布局并清除本地布局偏好。"
          : "已在当前页面恢复默认，但无法清除浏览器中的旧偏好。",
      );
    },
  };
}
