import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApprovalInboxController } from "@zentwine/client";
export function useApprovalInbox(org: string) {
  const controller = useMemo(() => new ApprovalInboxController(org), [org]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(() => {
    const reload = () => {
      if (document.visibilityState === "hidden" || !navigator.onLine)
        controller.suspend();
      else void controller.reload();
    };
    reload();
    window.addEventListener("focus", reload);
    window.addEventListener("online", reload);
    window.addEventListener("pageshow", reload);
    window.addEventListener("offline", controller.suspend);
    window.addEventListener("pagehide", controller.suspend);
    document.addEventListener("visibilitychange", reload);
    return () => {
      controller.suspend();
      window.removeEventListener("focus", reload);
      window.removeEventListener("online", reload);
      window.removeEventListener("pageshow", reload);
      window.removeEventListener("offline", controller.suspend);
      window.removeEventListener("pagehide", controller.suspend);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [controller]);
  return {
    state,
    reload: controller.reload,
    next: controller.next,
    switchOrganization: controller.switchOrganization,
  };
}
