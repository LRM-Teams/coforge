import { useEffect } from "react";
import { getRouteApi, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { MessageSquare01 as MessagesSquare } from "@untitledui/icons";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { ConversationPending } from "./conversation-pending";

const messagesRoute = getRouteApi("/_app/messages");

/**
 * The Chat detail pane with no conversation in the URL. On a desktop-wide viewport, where list and
 * detail sit side by side, Chat opens the first channel the viewer has joined — the top of the
 * sidebar's CHANNELS group (the server lists pinned channels first) — instead of asking for a
 * choice. Narrower viewports show the list and never jump past it (docs/design/task-first-layout.md
 * §2.1). With no joined channel there is nothing to open, so the pane asks for a choice.
 */
export function EmptyConversation() {
  const { channels } = messagesRoute.useLoaderData();
  const landingChannelId = channels.find((channel) => channel.joined && !channel.archived)?.id;
  const desktop = useBreakpoint("lg");
  const navigate = useNavigate();
  useEffect(() => {
    if (!desktop || !landingChannelId) return;
    void navigate({
      to: "/messages/channels/$channelId",
      params: { channelId: landingChannelId },
      replace: true,
    });
  }, [desktop, landingChannelId, navigate]);

  // The router keeps this pane up until the chosen conversation's own pending fallback is due, so
  // for that moment it would still ask for a choice the user has just made: show the conversation
  // skeleton from the first frame instead. The same holds while the landing channel opens, and
  // the server render already shows the skeleton, so no frame asks for a choice first.
  const matchRoute = useMatchRoute();
  const opening =
    !matchRoute({ to: "/messages/saved", pending: true }) &&
    (matchRoute({ to: "/messages/channels/$channelId", pending: true }) ||
      matchRoute({ to: "/messages/$agentId", pending: true }));
  if (opening || landingChannelId) return <ConversationPending />;
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
