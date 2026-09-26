import { useEffect, useMemo, useSyncExternalStore } from "react";
import { CatalogApprovalController } from "@zentwine/client";
import type { CatalogApprovalRoute } from "@zentwine/contracts";
export function useCatalogApproval(route: CatalogApprovalRoute) {
  const controller = useMemo(
    () => new CatalogApprovalController(route),
    [route.org, route.mode, route.id],
  );
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
    window.addEventListener("pageshow", reload);
    window.addEventListener("online", reload);
    window.addEventListener("offline", controller.suspend);
    window.addEventListener("pagehide", controller.suspend);
    document.addEventListener("visibilitychange", reload);
    return () => {
      controller.suspend();
      window.removeEventListener("focus", reload);
      window.removeEventListener("pageshow", reload);
      window.removeEventListener("online", reload);
      window.removeEventListener("offline", controller.suspend);
      window.removeEventListener("pagehide", controller.suspend);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [controller]);
  return {
    state,
    reload: controller.reload,
    request: controller.request,
    retryRequest: controller.retryRequest,
    command: controller.command,
    switchOrganization: controller.switchOrganization,
  };
}
