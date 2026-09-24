import { Suspense, useMemo, useState, type ComponentProps } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly } from "@tanstack/react-router";
import { MessageSquare02, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ConversationPane } from "#src/features/conversations/conversation-pane";
import {
  channelNamesQuery,
  directConversationQuery,
  directConversationUpdates,
  publicChannelQuery,
  publicChannelUpdates,
  useConversationQuery,
} from "#src/features/conversations/conversation-queries";
import { m } from "#src/paraglide/messages";
import type { RememberedEntity } from "./search-memory";

/** What the preview shows: a channel or an Agent's direct conversation, optionally at a message. */
export type SearchPreviewTarget = RememberedEntity & { messageId?: string };

/**
 * A result's conversation beside the search results: read-only (no composer, reactions, Tasks or
 * thread panes, and nothing is marked read), positioned at the message when there is one. Its
 * header names the place and offers to open the conversation itself or close the preview.
 */
export function SearchPreview({
  target,
  title,
  onOpen,
  onClose,
}: {
  target: SearchPreviewTarget;
  /** `#channel` or the Agent's name. */
  title: string;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <section
      aria-label={m.search_preview()}
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-secondary bg-primary"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-secondary px-4">
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold text-primary">{title}</h2>
        <Button
          size="sm"
          color="secondary"
          iconLeading={MessageSquare02}
          aria-label={m.search_preview_open()}
          onClick={onOpen}
        >
          {m.search_preview_open()}
        </Button>
        <ButtonUtility
          icon={XClose}
          size="sm"
          color="tertiary"
          tooltip={m.search_preview_close()}
          onClick={onClose}
        />
      </header>
      {failed ? (
        <p role="alert" className="p-4 text-sm text-error-primary">
          {m.search_preview_failed()}
        </p>
      ) : (
        <ClientOnly>
          <CatchBoundary
            getResetKey={() => `${target.kind}:${target.id}`}
            errorComponent={() => null}
            onCatch={() => setFailed(true)}
          >
            <Suspense fallback={null}>
              {target.kind === "channel" ? (
                <ChannelPreview channelId={target.id} messageId={target.messageId} />
              ) : (
                <DirectPreview agentId={target.id} messageId={target.messageId} />
              )}
            </Suspense>
          </CatchBoundary>
        </ClientOnly>
      )}
    </section>
  );
}

/** Only the conversation's messages, kept live: none of a page's Tasks or actions. */
function ChannelPreview({ channelId, messageId }: { channelId: string; messageId?: string }) {
  const page = useConversationQuery({
    ...publicChannelQuery(channelId),
    loadUpdates: publicChannelUpdates(channelId),
  });
  return <PreviewPane page={page} messageId={messageId} />;
}

function DirectPreview({ agentId, messageId }: { agentId: string; messageId?: string }) {
  const page = useConversationQuery({
    ...directConversationQuery(agentId),
    loadUpdates: directConversationUpdates(agentId),
  });
  return <PreviewPane page={page} messageId={messageId} />;
}

/** The loaded conversation's top-level stream, with its paging, jumped to `messageId`. */
function PreviewPane({
  page,
  messageId,
}: {
  page: {
    conversation: ComponentProps<typeof ConversationPane>["conversation"];
    loadOlder: ComponentProps<typeof ConversationPane>["onLoadOlder"];
    loadNewer: ComponentProps<typeof ConversationPane>["onLoadNewer"];
    loadMessageAround: ComponentProps<typeof ConversationPane>["onLoadMessageAround"];
    showLatest: ComponentProps<typeof ConversationPane>["onShowLatest"];
  };
  messageId?: string;
}) {
  const { conversation } = page;
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  const channelNames = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.name])),
    [channels],
  );
  // The stream shows top-level messages; a thread's replies stay behind its root.
  const roots = useMemo(
    () => ({
      ...conversation,
      messages: conversation.messages.filter((message) => !message.threadRootId),
    }),
    [conversation],
  );
  return (
    <ConversationPane
      conversation={roots}
      emptyState={{
        title: m.search_preview_empty(),
        description: "",
        media: <MessageSquare02 aria-hidden="true" className="size-6 text-tertiary" />,
      }}
      readOnlyNotice={
        // The header's "Open conversation" is the way to reply; one button, not two.
        <p className="rounded-xl border border-secondary bg-secondary px-4 py-3 text-sm text-tertiary">
          {m.search_preview_read_only()}
        </p>
      }
      // The preview never sends; the composer is replaced by the notice above.
      onSend={async () => {
        throw new Error("The search preview does not send messages");
      }}
      onLoadOlder={page.loadOlder}
      onLoadNewer={page.loadNewer}
      onLoadMessageAround={page.loadMessageAround}
      onShowLatest={page.showLatest}
      channelNames={channelNames}
      channels={channels}
      jumpMessage={messageId}
    />
  );
}
