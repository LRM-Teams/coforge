import { useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { getWorkspaceConversationSubscriptionToken } from "#src/features/realtime/realtime.functions";
import { isAppError } from "#src/lib/app-error";
import { decodeWorkspaceDeletedEvent } from "./workspace-realtime";
import { openWorkspace } from "./workspaces.functions";

/**
 * Takes this page out of the Workspace once it is gone for the viewer, to `/`, which opens the
 * next Workspace they are in, or creating a first one when there is none. Either it hears
 * `workspace.deleted.v1`, or it missed that (it was reconnecting) and the Workspace channel can
 * no longer be subscribed: the page then asks whether the Workspace is still the viewer's, and
 * leaves when it is not found or not theirs any more. Renders nothing; it must sit below
 * `BrowserRealtimeProvider`.
 */
export function LeaveDeletedWorkspace({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const getToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const checkWorkspace = useServerFn(openWorkspace);
  const checking = useRef(false);

  const onPublication = useCallback(
    (publication: { data: unknown }) => {
      if (decodeWorkspaceDeletedEvent(publication.data)?.workspaceId === workspaceId)
        void navigate({ to: "/" });
    },
    [navigate, workspaceId],
  );

  const onError = useCallback(() => {
    if (checking.current) return;
    checking.current = true;
    checkWorkspace()
      .catch((error: unknown) => {
        const code = isAppError(error) ? error.code : undefined;
        if (code === "NOT_FOUND" || code === "ACCESS_DENIED") return navigate({ to: "/" });
      })
      .finally(() => {
        checking.current = false;
      });
  }, [checkWorkspace, navigate]);

  useRealtimeSubscription({
    channel: workspaceConversationChannel(workspaceId),
    getToken,
    onPublication,
    onError,
  });
  return null;
}
