import { useEffect, useMemo, useSyncExternalStore } from "react";
import { WorkbenchController } from "@zentwine/client";
import type { WorkbenchView } from "@zentwine/contracts";
/** Browser events are invalidation hints only. All authority is fetched again from the server. */
export function useOrganizationWorkbench(
  org: string | null,
  view: WorkbenchView,
  objectId?: string,
) {
  const controller = useMemo(
    () => new WorkbenchController(org, view, undefined, objectId),
    [org, view, objectId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === "hidden" || !navigator.onLine)
        controller.suspend();
      else void controller.reload();
    };
    revalidate();
    window.addEventListener("focus", revalidate);
    window.addEventListener("pageshow", revalidate);
    window.addEventListener("online", revalidate);
    window.addEventListener("offline", controller.suspend);
    window.addEventListener("pagehide", controller.suspend);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      controller.suspend();
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("pageshow", revalidate);
      window.removeEventListener("online", revalidate);
      window.removeEventListener("offline", controller.suspend);
      window.removeEventListener("pagehide", controller.suspend);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [controller]);
  return {
    state,
    reload: controller.reload,
    switchOrganization: controller.switchOrganization,
    logout: controller.logout,
  };
}
