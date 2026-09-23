import { useMatchRoute } from "@tanstack/react-router";
import { MessageSquare01 as MessagesSquare } from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import { ConversationPending } from "./conversation-pending";

export function EmptyConversation() {
  // The router keeps this pane up until the chosen conversation's own pending fallback is due, so
  // for that moment it would still ask for a choice the user has just made: show the conversation
  // skeleton from the first frame instead.
  const matchRoute = useMatchRoute();
  const opening =
    !matchRoute({ to: "/messages/saved", pending: true }) &&
    (matchRoute({ to: "/messages/channels/$channelId", pending: true }) ||
      matchRoute({ to: "/messages/$agentId", pending: true }));
  if (opening) return <ConversationPending />;
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
