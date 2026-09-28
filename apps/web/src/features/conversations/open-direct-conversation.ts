import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import {
  openDirectConversation,
  type loadDirectConversationTarget,
} from "./conversations.functions";
import { directConversationTargetQuery } from "./conversation-queries";

type DirectConversationTarget = Awaited<ReturnType<typeof loadDirectConversationTarget>>;

/**
 * Opens the viewer's direct conversation with an Agent or a member (starting it on first use) and
 * goes to its page, as Raft's "Message" button does. A failure says why in a toast.
 */
export function useOpenDirectConversation() {
  const open = useServerFn(openDirectConversation);
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const toast = useAppToast();
  const queryClient = useQueryClient();
  return useCallback(
    async (peer: { agentId: string } | { userId: string }) => {
      try {
        const { conversationId } = await open({ data: peer });
        // Who it is with is already known: the page need not ask the server again.
        const target: DirectConversationTarget =
          "agentId" in peer
            ? { kind: "agent", agentId: peer.agentId }
            : { kind: "people", peerUserId: peer.userId };
        queryClient.setQueryData(directConversationTargetQuery(conversationId).queryKey, target);
        await navigate({
          to: "/w/$workspaceSlug/dm/$dmId",
          params: { workspaceSlug, dmId: conversationId },
        });
      } catch {
        toast.error(m.conversation_open_error());
      }
    },
    [open, navigate, workspaceSlug, toast, queryClient],
  );
}
