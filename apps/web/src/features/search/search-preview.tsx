import { Suspense, useState } from "react";
import { usePrefetchQuery, useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly, getRouteApi } from "@tanstack/react-router";

import { Skeleton } from "#src/components/ui/skeleton";
import { useOpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { agentIdFromProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import {
  useCurrentWorkspaceId,
  useLiveAgent,
} from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversation } from "#src/features/conversations/channel-conversation";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import { DirectConversation } from "#src/features/conversations/direct-conversation";
import {
  useChannelConversation,
  useDirectConversation,
} from "#src/features/conversations/use-conversation-data";
import { m } from "#src/paraglide/messages";
import type { RememberedEntity } from "./search-memory";

const searchRoute = getRouteApi("/_app/search");

/** What the preview shows: a channel or an Agent's direct conversation, optionally at a message. */
export type SearchPreviewTarget = RememberedEntity & { messageId?: string };

/**
 * A result's conversation beside the search results: the conversation itself, as its page shows
 * it (its header, the stream positioned at the message, the composer, threads, reactions and the
 * Agent profile), without the Chat / Tasks / Files tabs. Previewing is not reading: nothing is
 * marked read.
 */
export function SearchPreview({ target }: { target: SearchPreviewTarget }) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Read alongside the conversation rather than after it: both hold the preview back.
  usePrefetchQuery(channelNamesQuery(workspaceId));
  const [failed, setFailed] = useState(false);
  return (
    <section
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
                <ChannelPreview channelId={target.id} />
              ) : (
                <DirectPreview agentId={target.id} />
              )}
            </Suspense>
          </CatchBoundary>
        </ClientOnly>
      )}
    </section>
  );
}

function ChannelPreview({ channelId }: { channelId: string }) {
  const { conversationProps } = useChannelConversation(channelId);
  const place = usePreviewPlace();
  return <ChannelConversation {...conversationProps} {...place} />;
}

function DirectPreview({ agentId }: { agentId: string }) {
  const { conversationProps } = useDirectConversation(agentId);
  const agentStatus = useLiveAgent(agentId)?.status.value;
  const place = usePreviewPlace();
  return <DirectConversation {...conversationProps} agentStatus={agentStatus} {...place} />;
}

/** What the messages layout gives a conversation page and the search page supplies itself: the
 * Workspace's channels (for references) and the Agent profile panel, kept in the search URL. */
function usePreviewPlace() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery(channelNamesQuery(workspaceId)).data;
  const { profile, agentTab } = searchRoute.useSearch();
  const { openAgentProfile, setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  return {
    channels,
    onOpenAgentProfile: openAgentProfile,
    agentProfile: { agentId: agentIdFromProfileParam(profile), tab: agentTab },
    onAgentProfileTabChange: setAgentProfileTab,
    onCloseAgentProfile: closeAgentProfile,
  };
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
