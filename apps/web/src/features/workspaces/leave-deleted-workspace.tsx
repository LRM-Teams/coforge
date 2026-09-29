import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { getWorkspaceConversationSubscriptionToken } from "#src/features/realtime/realtime.functions";
import { decodeWorkspaceDeletedEvent } from "./workspace-realtime";

/**
 * Takes this page out of the Workspace once its owner deletes it (`workspace.deleted.v1`): `/`
 * opens the next Workspace the viewer is in, or creating a first one when there is none. Renders nothing;
 * it must sit below `BrowserRealtimeProvider`.
 */
export function LeaveDeletedWorkspace({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const getToken = useServerFn(getWorkspaceConversationSubscriptionToken);

  const onPublication = useCallback(
    (publication: { data: unknown }) => {
      if (decodeWorkspaceDeletedEvent(publication.data)?.workspaceId === workspaceId)
        void navigate({ to: "/" });
    },
    [navigate, workspaceId],
  );

  useRealtimeSubscription({
    channel: workspaceConversationChannel(workspaceId),
    getToken,
    onPublication,
  });
  return null;
}
