import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Bookmark, BookmarkCheck } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { PageHeader } from "#src/components/layout/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useAppToast } from "#src/components/ui/toast";
import { useLiveAgents } from "#src/features/agents/workspace-agents-realtime";
import { m } from "#src/paraglide/messages";
import { MessageBody } from "./message-body";
import { useSavedMessages } from "./conversation-navigation";
import { unsaveMessage } from "./saved-messages.functions";
import { agentIdFromDirectKey, savedJumpTarget } from "./saved-messages-model";

/**
 * The Saved view (#127), the detail side of the Chat page's list/detail layout: each bookmarked
 * message is a card with its conversation label, sender, time, and a clamped body excerpt. The
 * whole card jumps back to the message's position in its conversation — a thread reply lands on
 * its root's row and the pane never auto-opens the thread (position-only `?message=` search
 * param, not the notification deep link's `#message-<id>` hash; see `saved-messages-model`) —
 * the trailing bookmark unsaves in one click (instantly reversible, so no confirm — the card
 * disappearing is the confirmation, docs/design/toast-vs-inline.md §13).
 */
export function SavedMessagesView() {
  const saved = useSavedMessages();
  const agents = useLiveAgents();
  const toast = useAppToast();
  const unsave = useServerFn(unsaveMessage);
  const entries = saved?.entries ?? [];
  if (!saved) return null;
  const agentName = (agentId: string) => agents.find((agent) => agent.id === agentId)?.displayName;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader heading={m.conversation_saved_title()} />
      {entries.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Bookmark aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{m.conversation_saved_empty_title()}</EmptyTitle>
              <EmptyDescription>{m.conversation_saved_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {entries.map((entry) => {
            const jump = savedJumpTarget(entry.conversation, entry.message);
            const agentId = agentIdFromDirectKey(entry.conversation.directKey);
            const conversationLabel = entry.conversation.channelName
              ? `#${entry.conversation.channelName}`
              : agentId
                ? (agentName(agentId) ?? m.conversation_saved_dm())
                : m.conversation_saved_dm();
            const jumpProps =
              jump.to === "/messages/channels/$channelId"
                ? { to: jump.to, params: jump.params, search: jump.search }
                : jump.to === "/messages/$agentId"
                  ? { to: jump.to, params: jump.params, search: jump.search }
                  : { to: jump.to };
            const attachmentName = entry.message.attachments[0]?.fileName;
            return (
              <li
                key={entry.message.id}
                className="flex items-start gap-2 rounded-xl border border-secondary bg-primary p-3 transition-colors hover:bg-secondary"
              >
                <Link
                  {...jumpProps}
                  className="min-w-0 flex-1 rounded-lg outline-focus-ring focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-center gap-2 text-xs text-tertiary">
                    <span className="truncate font-medium text-secondary">{conversationLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{entry.message.senderName}</span>
                    <span aria-hidden="true">·</span>
                    <RelativeTime value={entry.message.createdAt} />
                  </div>
                  {entry.message.body ? (
                    <div className="mt-1 line-clamp-3 text-sm leading-5 text-secondary [&_p]:my-0">
                      <MessageBody body={entry.message.body} mentions={entry.message.mentions} />
                    </div>
                  ) : attachmentName ? (
                    <p className="mt-1 truncate text-sm text-tertiary">{attachmentName}</p>
                  ) : null}
                </Link>
                <ButtonUtility
                  icon={BookmarkCheck}
                  size="xs"
                  color="tertiary"
                  tooltip={m.conversation_unsave()}
                  aria-label={m.conversation_unsave()}
                  onClick={() => {
                    void unsave({
                      data: {
                        conversationId: entry.conversation.id,
                        messageId: entry.message.id,
                      },
                    })
                      .then(() => saved.refresh())
                      .catch(() => toast.error(m.conversation_save_failed()));
                  }}
                  className="shrink-0"
                />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
