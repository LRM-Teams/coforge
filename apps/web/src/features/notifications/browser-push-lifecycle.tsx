import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  browserNotificationPermission,
  browserPushLifecycleEnabled,
  ensureBrowserPushSubscription,
} from "./browser-push";
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
    void ensureBrowserPushSubscription(publicKey)
      .then((subscription) => {
        if (browserPushLifecycleEnabled()) return subscribe({ data: subscription });
      })
      .catch(() => {
        // Settings shows actionable permission and subscription errors.
      });
  }, [enabled, publicKey, subscribe]);

  return null;
}
