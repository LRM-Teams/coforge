import { useEffect, useState } from "react";
import { getRouteApi, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { MessageSquare01 as MessagesSquare } from "@untitledui/icons";

import {
  useCurrentWorkspaceId,
  useLiveAgents,
} from "#src/features/agents/workspace-agents-realtime";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { ConversationPending } from "./conversation-pending";
import { rememberedConversation } from "./last-conversation";

const messagesRoute = getRouteApi("/_app/messages");

/**
 * The Chat detail pane with no conversation in the URL. On a desktop-wide viewport, where list and
 * detail sit side by side, Chat reopens the conversation the user had open last in this Workspace
 * (`last-conversation.ts`), or else the first channel they have joined — the top of the sidebar's
 * CHANNELS group (the server lists pinned channels first) — instead of asking for a choice.
 * Narrower viewports show the list and never jump past it (docs/design/task-first-layout.md §2.1).
 * With nothing to open, the pane asks for a choice.
 */
export function EmptyConversation() {
  const { channels, directPreferences } = messagesRoute.useLoaderData();
  const agents = useLiveAgents();
  const workspaceId = useCurrentWorkspaceId();
  const landingChannelId = channels.find((channel) => channel.joined && !channel.archived)?.id;
  const desktop = useBreakpoint("lg");
  const navigate = useNavigate();
  // Known only after mount (`localStorage`), so the server render cannot count on it.
  const [reopening, setReopening] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    const remembered = workspaceId
      ? rememberedConversation(workspaceId, {
          channelIds: channels.filter((channel) => !channel.archived).map((channel) => channel.id),
          // A closed direct message is out of the list until someone writes in it again.
          agentIds: agents
            .map((agent) => agent.id)
            .filter((agentId) => !directPreferences.hidden.includes(agentId)),
        })
      : undefined;
    const target = remembered ?? (landingChannelId ? { channelId: landingChannelId } : undefined);
    if (!target) return;
    setReopening(true);
    if ("channelId" in target) {
      void navigate({
        to: "/messages/channels/$channelId",
        params: { channelId: target.channelId },
        replace: true,
      });
    } else if ("agentId" in target) {
      void navigate({
        to: "/messages/$agentId",
        params: { agentId: target.agentId },
        replace: true,
      });
    } else {
      void navigate({ to: "/messages/saved", replace: true });
    }
  }, [desktop, workspaceId, channels, agents, directPreferences, landingChannelId, navigate]);

  // The router keeps this pane up until the chosen conversation's own pending fallback is due, so
  // for that moment it would still ask for a choice the user has just made: show the conversation
  // skeleton from the first frame instead. The same holds while Chat opens its conversation, and
  // the server render already shows the skeleton when a joined channel exists, so no frame asks
  // for a choice first.
  const matchRoute = useMatchRoute();
  const opening =
    !matchRoute({ to: "/messages/saved", pending: true }) &&
    (matchRoute({ to: "/messages/channels/$channelId", pending: true }) ||
      matchRoute({ to: "/messages/$agentId", pending: true }));
  if (opening || reopening || landingChannelId) return <ConversationPending />;
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
