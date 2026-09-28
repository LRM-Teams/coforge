import { memo, Suspense, useState, type Ref } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly, getRouteApi } from "@tanstack/react-router";

import { Skeleton } from "#src/components/ui/skeleton";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversationPage } from "#src/features/conversations/channel-conversation-page";
import { DirectConversationPage } from "#src/features/conversations/direct-conversation-page";
import { m } from "#src/paraglide/messages";
import type { RememberedEntity } from "./search-memory";
import { searchDirectoryQuery } from "./search-queries";

const searchRoute = getRouteApi("/_app/search");

/** What the preview shows: a channel or an Agent's direct conversation, optionally at a message. */
export type SearchPreviewTarget = RememberedEntity & {
  messageId?: string;
  /** A thread reply's root: the preview opens that thread. */
  threadRootId?: string;
};

/**
 * A result's conversation beside the search results, exactly as Chat opens it: the same page
 * (`ChannelConversationPage` / `DirectConversationPage`) with its tabs, stream positioned at the
 * message, composer, threads, Task board and files, and reading it as Chat does. Memoized: typing
 * in the search box re-renders the search page, not the conversation.
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
  return (
    <ChannelConversationPage
      channelId={channelId}
      jumpMessage={jumpMessage}
      {...usePreviewPageProps()}
    />
  );
}

function DirectPreview({ agentId, jumpMessage }: { agentId: string; jumpMessage?: string }) {
  return (
    <DirectConversationPage
      agentId={agentId}
      jumpMessage={jumpMessage}
      {...usePreviewPageProps()}
    />
  );
}

/** What the page reads from Chat that the search page supplies itself: its own address state (the
 * tab, board view and what it has open, kept in the search URL) and the Workspace's channels (for
 * references; the search page has already read them). */
function usePreviewPageProps() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery({
    ...searchDirectoryQuery(workspaceId),
    select: (directory) => directory.channels,
  }).data;
  // Only the page's own fields, shared structurally: typing a query does not re-render the page.
  const search = searchRoute.useSearch({
    select: ({
      view,
      status,
      layout,
      owners,
      completed,
      threadRootId,
      task,
      profile,
      agentTab,
    }) => ({
      view,
      status,
      layout,
      owners,
      completed,
      threadRootId,
      task,
      profile,
      agentTab,
    }),
    structuralSharing: true,
  });
  return { search, channels };
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
