import { useCallback, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { getUserConversationSubscriptionToken } from "#src/features/realtime/realtime.functions";
import {
  decodeNotificationAvailableEvent,
  userConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { browserNotificationPermission, showPageNotification } from "./browser-push";
import { getMessageNotification } from "./notifications.functions";

/**
 * Whether the page should even ask the server for a notification to show. Gates on the same
 * preference `BrowserPushLifecycle` reads plus a granted `Notification` permission — with either
 * missing there is nothing to show and no need to fetch.
 */
export function isInPageNotificationEnabled(input: {
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
}): boolean {
  return input.enabled && input.permission === "granted";
}

/**
 * Whether to actually call `showNotification` once the recipient's notification has been fetched.
 * Skipped only while the tab is the visible, focused window already looking at the conversation the
 * notification is about — the member is already reading it, so an OS notification would be noise.
 */
export function shouldShowInPageNotification(input: {
  visible: boolean;
  focused: boolean;
  pathname: string;
  conversationPath: string;
}): boolean {
  return !(input.visible && input.focused && input.pathname === input.conversationPath);
}

/**
 * Shows the OS notification itself from the realtime `notification.available.v1` signal while a
 * CoForge tab is open: Google's push services are unreachable from mainland-China
 * staging and clients, so Web Push alone never reaches Chrome there. Renders nothing; Web Push
 * (`BrowserPushLifecycle`) still owns delivery once every tab is closed.
 *
 * `workspaceId` gates readiness the same way `BrowserRealtimeProvider` itself does — the shared
 * connection, and the `chat:user:` subscription token, both require a selected Workspace — not to
 * filter which Workspace's notifications show: a member expects to hear about other Workspaces
 * too while working in this one.
 */
export function InPageNotifications({
  enabled,
  viewerId,
  workspaceId,
}: {
  enabled: boolean;
  viewerId?: string;
  workspaceId?: string;
}) {
  const getToken = useServerFn(getUserConversationSubscriptionToken);
  const fetchNotification = useServerFn(getMessageNotification);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const onPublication = useCallback(
    (publication: { data: unknown }) => {
      let event;
      try {
        event = decodeNotificationAvailableEvent(publication.data);
      } catch {
        // The same channel also carries `message.available.v1`; not for us.
        return;
      }
      void showInPageNotification(event.messageId, enabledRef, fetchNotification);
    },
    [fetchNotification],
  );

  useRealtimeSubscription({
    channel: enabled && viewerId && workspaceId ? userConversationChannel(viewerId) : undefined,
    getToken: enabled && viewerId && workspaceId ? getToken : undefined,
    onPublication,
  });

  return null;
}

async function showInPageNotification(
  messageId: string,
  enabledRef: { current: boolean },
  fetchNotification: (input: {
    data: { messageId: string };
  }) => Promise<Awaited<ReturnType<typeof getMessageNotification>>>,
) {
  if (
    !isInPageNotificationEnabled({
      enabled: enabledRef.current,
      permission: browserNotificationPermission(),
    })
  )
    return;
  let notification;
  try {
    notification = await fetchNotification({ data: { messageId } });
  } catch (cause) {
    console.warn("in-page notification fetch failed", cause);
    return;
  }
  if (!notification) return;
  if (
    !shouldShowInPageNotification({
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
      pathname: window.location.pathname,
      conversationPath: notification.conversationPath,
    })
  )
    return;
  try {
    // Same tag format as Web Push (`message:<id>`, see `messageNotificationTag`): a later push for
    // the same message replaces this one instead of duplicating it.
    await showPageNotification(notification);
  } catch (cause) {
    console.warn("in-page notification display failed", cause);
  }
}
