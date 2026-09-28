import { memo, Suspense, useState, type Ref } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly, getRouteApi } from "@tanstack/react-router";

import { Skeleton } from "#src/components/ui/skeleton";
import { useConversationAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import {
  useCurrentWorkspaceId,
  useLiveAgent,
} from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversation } from "#src/features/conversations/channel-conversation";
import { DirectConversation } from "#src/features/conversations/direct-conversation";
import {
  useChannelConversation,
  useDirectConversation,
} from "#src/features/conversations/use-conversation-data";
import { m } from "#src/paraglide/messages";
import type { RememberedEntity } from "./search-memory";
import { searchDirectoryQuery } from "./search-queries";

const searchRoute = getRouteApi("/_app/search");

/** What the preview shows: a channel or an Agent's direct conversation, optionally at a message. */
export type SearchPreviewTarget = RememberedEntity & { messageId?: string };

/**
 * A result's conversation beside the search results: the conversation itself, as its page shows
 * it (its header, the stream positioned at the message, the composer, threads, reactions and the
 * Agent profile), without the Chat / Tasks / Files tabs. Previewing is not reading: the stream is
 * not marked read, though a thread opened in the preview is, as in Chat. Memoized: typing in the search box re-renders the page, not the conversation.
 */
export const SearchPreview = memo(function SearchPreview({
  target,
  ref,
}: {
  target: SearchPreviewTarget;
  ref?: Ref<HTMLElement>;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <section
      ref={ref}
      aria-label={m.search_preview()}
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-secondary bg-primary"
    >
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
            <Suspense fallback={<PreviewSkeleton />}>
              {target.kind === "channel" ? (
                <ChannelPreview channelId={target.id} jumpMessage={target.messageId} />
              ) : (
                <DirectPreview agentId={target.id} jumpMessage={target.messageId} />
              )}
            </Suspense>
          </CatchBoundary>
        </ClientOnly>
      )}
    </section>
  );
});

function ChannelPreview({ channelId, jumpMessage }: { channelId: string; jumpMessage?: string }) {
  const { conversationProps } = useChannelConversation(channelId);
  const previewProps = usePreviewConversationProps();
  return <ChannelConversation {...conversationProps} {...previewProps} jumpMessage={jumpMessage} />;
}

function DirectPreview({ agentId, jumpMessage }: { agentId: string; jumpMessage?: string }) {
  const { conversationProps } = useDirectConversation(agentId);
  const agentStatus = useLiveAgent(agentId)?.status.value;
  const previewProps = usePreviewConversationProps();
  return (
    <DirectConversation
      {...conversationProps}
      {...previewProps}
      agentStatus={agentStatus}
      jumpMessage={jumpMessage}
    />
  );
}

/** The props a conversation page gets from the messages layout, which the preview supplies itself: the
 * Workspace's channels (for references; the search page has already read them) and the Agent
 * profile panel, kept in the search URL. */
function usePreviewConversationProps() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery({
    ...searchDirectoryQuery(workspaceId),
    select: (directory) => directory.channels,
  }).data;
  const profile = searchRoute.useSearch({ select: (search) => search.profile });
  const agentTab = searchRoute.useSearch({ select: (search) => search.agentTab });
  return { channels, ...useConversationAgentProfile({ profile, agentTab }) };
}

/** Message-shaped placeholders while the conversation loads. */
function PreviewSkeleton() {
  return (
    <div role="status" aria-label={m.search_preview_loading()} className="flex flex-col gap-4 p-4">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
