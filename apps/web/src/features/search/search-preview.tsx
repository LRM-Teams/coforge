import { memo, Suspense, useState, type Ref } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, ClientOnly, getRouteApi } from "@tanstack/react-router";

import { Skeleton } from "#src/components/ui/skeleton";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelConversationPage } from "#src/features/conversations/channel-conversation-page";
import { pickConversationPageSearch } from "#src/features/conversations/conversation-page-search";
import { ConversationViewerProvider } from "#src/features/conversations/conversation-viewer";
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
              <PreviewPage target={target} />
            </Suspense>
          </CatchBoundary>
        </ClientOnly>
      )}
    </section>
  );
});

/**
 * The conversation page itself, under what Chat's layout gives it and the search page supplies:
 * the viewer's Saved list (read by the route's loader), the Workspace's channels (the search page
 * has already read them) and the page's own address state out of the search URL.
 */
function PreviewPage({ target }: { target: SearchPreviewTarget }) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useSuspenseQuery({
    ...searchDirectoryQuery(workspaceId),
    select: (directory) => directory.channels,
  }).data;
  const saved = searchRoute.useLoaderData();
  // Only the page's own fields, shared structurally: typing a query does not re-render the page.
  const search = searchRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  const jumpMessage = target.messageId;
  return (
    <ConversationViewerProvider saved={saved} channels={channels}>
      {target.kind === "channel" ? (
        <ChannelConversationPage channelId={target.id} search={search} jumpMessage={jumpMessage} />
      ) : (
        <DirectConversationPage agentId={target.id} search={search} jumpMessage={jumpMessage} />
      )}
    </ConversationViewerProvider>
  );
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
