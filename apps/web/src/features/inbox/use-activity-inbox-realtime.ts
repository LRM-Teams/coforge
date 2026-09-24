import { useCallback, useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  decodeActivityChangedEvent,
  decodeMessageAvailableEvent,
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  getUserConversationSubscriptionToken,
  getWorkspaceConversationSubscriptionToken,
} from "#src/features/realtime/realtime.functions";

/** A burst of messages (an Agent posting several in a row) refreshes the listener once. */
const REFRESH_DELAY_MS = 300;

/**
 * Listens to the viewer's workspace and user conversation channels and calls `onActivity` (once
 * per burst) when a message arrives. The Activity page refreshes its list with it; the nav rail's
 * Activity dot re-reads its attention count with it.
 */
export function useActivityInboxRealtime({
  workspaceId,
  userId,
  onActivity,
}: {
  workspaceId: string;
  userId: string;
  onActivity: () => void;
}) {
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  const onActivityRef = useRef(onActivity);
  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onPublication = useCallback((publication: { data: unknown }) => {
    try {
      decodeMessageAvailableEvent(publication.data);
    } catch {
      try {
        decodeActivityChangedEvent(publication.data);
      } catch {
        // Neither a message nor an Activity signal (the channels also carry other events).
        return;
      }
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onActivityRef.current(), REFRESH_DELAY_MS);
  }, []);

  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    getToken: workspaceId ? getWorkspaceToken : undefined,
    onPublication,
  });
  useRealtimeSubscription({
    channel: userConversationChannel(userId),
    getToken: getUserToken,
    onPublication,
  });
}
