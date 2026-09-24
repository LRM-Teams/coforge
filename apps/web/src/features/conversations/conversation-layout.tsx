import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { MessageSquare01 as MessagesSquare } from "@untitledui/icons";

import {
  useCurrentWorkspaceId,
  useLiveAgents,
} from "#src/features/agents/workspace-agents-realtime";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { ConversationPending } from "./conversation-pending";
import { useSidebarLists } from "./sidebar-lists";
import {
  conversationAt,
  conversationRoute,
  firstJoinedChannel,
  landingConversation,
  rememberedConversation,
} from "./last-conversation";

/**
 * The Chat detail pane with no conversation in the URL. On a desktop-wide viewport, where list and
 * detail sit side by side, Chat opens a conversation instead of asking for a choice
 * (`landingConversation`). Narrower viewports show the list and never jump past it
 * (docs/design/task-first-layout.md §2.1). With nothing to open, the pane asks for a choice.
 */
export function EmptyConversation() {
  const { channels, directPreferences } = useSidebarLists();
  const agents = useLiveAgents();
  const workspaceId = useCurrentWorkspaceId();
  const desktop = useBreakpoint("lg");
  const navigate = useNavigate();
  // While any navigation is under way (the landing one included) the pane leaves it alone; once
  // the router settles back here — say a Chat click interrupted the landing — it lands again.
  const navigating = useRouterState({ select: (state) => state.status === "pending" });
  useEffect(() => {
    if (!desktop || navigating) return;
    const target = landingConversation(
      workspaceId ? rememberedConversation(workspaceId) : undefined,
      {
        channels,
        agentIds: agents.map((agent) => agent.id),
        hiddenAgentIds: directPreferences.hidden,
      },
    );
    if (target) void navigate({ ...conversationRoute(target), replace: true });
  }, [desktop, navigating, workspaceId, channels, agents, directPreferences, navigate]);

  // While a channel or direct message is opening, this pane would still ask for the choice just
  // made until the router's pending fallback is due: show the conversation skeleton instead. The
  // server render shows it too when a joined channel will be opened, so no frame asks first.
  const opening = useRouterState({
    select: (state) => {
      if (state.status !== "pending") return false;
      const target = conversationAt(state.location.pathname);
      return target !== undefined && !("view" in target);
    },
  });
  if (opening || firstJoinedChannel(channels)) return <ConversationPending />;
  return (
    <div className="grid h-full place-content-center justify-items-center px-6 text-center">
      <div className="mb-5 flex size-12 items-center justify-center rounded-xl border border-secondary bg-primary shadow-xs">
        <MessagesSquare aria-hidden="true" className="size-6 text-tertiary" />
      </div>
      <p className="text-lg font-semibold">{m.messages_empty_title()}</p>
      <p className="mt-2 max-w-sm text-sm leading-6 text-tertiary">
        {m.messages_empty_description()}
      </p>
    </div>
  );
}
