import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";

import { browserNotificationPermission, syncBrowserPushSubscription } from "./browser-push";
import { subscribeBrowserPush } from "./notifications.functions";

export function BrowserPushLifecycle({
  enabled,
  publicKey,
}: {
  enabled: boolean;
  publicKey: string | null;
}) {
  const subscribe = useServerFn(subscribeBrowserPush);

  useEffect(() => {
    if (!enabled || !publicKey || browserNotificationPermission() !== "granted") return;
    syncBrowserPushSubscription(publicKey, (data) => subscribe({ data })).catch((cause) => {
      // Settings shows actionable errors; this background re-registration only leaves a trace.
      console.warn("browser push re-registration failed", cause);
    });
  }, [enabled, publicKey, subscribe]);

  return null;
}
