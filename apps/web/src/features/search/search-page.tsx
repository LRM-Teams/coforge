import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { MessageTextSquare01, SearchLg } from "@untitledui/icons";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { PageHeader } from "#src/components/layout/page-header";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { RelativeTime } from "#src/components/ui/relative-time";
import { Skeleton } from "#src/components/ui/skeleton";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { savedJumpTarget } from "#src/features/conversations/saved-messages-model";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { computerLabel } from "#src/features/computers/computer-identity";
import { messagePlainText } from "#src/features/conversations/selection-copy";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { searchTerms } from "#src/lib/search-terms";
import { m } from "#src/paraglide/messages";
import type { MessageSearchHit } from "#src/server/conversations/message-search.server";
import { matchSearchEntities, type SearchEntity } from "./search-entities";
import { SearchEntityList } from "./search-entity-list";
import { useResultClick } from "./search-click";
import { searchExcerpt } from "./search-excerpt";
import { SearchPreview, type SearchPreviewTarget } from "./search-preview";
import {
  isPreviewed,
  messagePreviewTarget,
  SearchPreviewContext,
  useSearchPreview,
} from "./search-preview-context";
import { SearchHome } from "./search-home";
import { searchEntityKey, type SearchEntityKey } from "./search-memory";
import { SEARCH_FOCUS_EVENT, useSearchShortcutLabel } from "./search-shortcut";
import { useSearchMemory } from "./use-search-memory";
import { SearchFilterBar } from "./search-filter-bar";
import { clearedFilters, hasActiveFilter, type SearchFilters } from "./search-filters";
import { messageSearchQuery, searchDirectoryQuery } from "./search-queries";
import { SEARCH_QUERY_MAX_LENGTH } from "./search.schemas";

/** Pause in typing before the query is committed to the URL and searched. */
const COMMIT_DELAY_MS = 200;

/**
 * The Workspace search page. The query and filters live in the URL, so a search can be shared,
 * reloaded, and returned to with Back; typing commits the query after a short pause, and never
 * while an input method is still composing. Filters search on their own, without a query.
 * On a wide screen a click previews a result's conversation beside the list (kept in the URL) and
 * a double click opens it; on a narrow one a click opens it. Esc closes the preview, then leaves.
 */
export function SearchPage({
  workspaceId,
  viewerId,
  deferred,
  timeZone,
  query,
  filters,
  onQueryChange,
  onFiltersChange,
  preview,
  onPreviewChange,
}: {
  workspaceId: string;
  viewerId: string;
  /** Filters alone do not search yet ("Search this channel" waits for a query). */
  deferred: boolean;
  timeZone: string | null;
  query: string;
  filters: SearchFilters;
  onQueryChange: (query: string) => void;
  onFiltersChange: (filters: SearchFilters) => void;
  preview: SearchPreviewTarget | undefined;
  onPreviewChange: (preview: SearchPreviewTarget | undefined) => void;
}) {
  const memory = useSearchMemory(workspaceId, viewerId);
  const router = useRouter();
  // A preview needs room beside the list; below `md` a click opens the conversation instead.
  const wide = useBreakpoint("md");
  const showPreview = Boolean(preview && wide);
  const directory = useQuery(searchDirectoryQuery(workspaceId)).data;
  const previewContext = useMemo(
    () => ({ previewed: preview, preview: wide ? onPreviewChange : undefined }),
    [preview, wide, onPreviewChange],
  );
  const shortcut = useSearchShortcutLabel();
  const [text, setText] = useState(query);
  // State, not a ref: ending a composition must re-run the commit effect even when the last
  // input event (which browsers fire before `compositionend`) already set the final text.
  const [composing, setComposing] = useState(false);
  // The query this input last committed, so its own URL update never overwrites what has been
  // typed since; only a change from elsewhere (a link, Back) replaces the text.
  const lastCommitted = useRef(query);
  const input = useRef<HTMLInputElement>(null);
  const committed = query.trim();

  useEffect(() => {
    if (query === lastCommitted.current) return;
    lastCommitted.current = query;
    setText(query);
  }, [query]);

  useEffect(() => {
    // Surrounding spaces never change the search, so they are not committed (and a space
    // typed ahead of a word is not wiped by the URL coming back without it).
    const next = text.trim();
    if (composing || next === lastCommitted.current) return;
    const timer = setTimeout(() => {
      lastCommitted.current = next;
      onQueryChange(next);
    }, COMMIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, composing, onQueryChange]);

  // The box opens focused with its text selected, ready to be typed over; Cmd/Ctrl+K on this
  // page does the same again.
  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    focus();
    document.addEventListener(SEARCH_FOCUS_EVENT, focus);
    return () => document.removeEventListener(SEARCH_FOCUS_EVENT, focus);
  }, []);

  const openPreviewed = () => {
    if (!preview) return;
    const route =
      preview.kind === "channel"
        ? conversationRoute({ channelId: preview.id })
        : conversationRoute({ agentId: preview.id });
    void router.navigate({ ...route, search: { message: preview.messageId } });
  };
  const previewTitle =
    preview?.kind === "channel"
      ? `#${directory?.channels.find((channel) => channel.id === preview.id)?.name ?? ""}`
      : (directory?.agents.find((agent) => agent.id === preview?.id)?.name ?? "");

  // Esc closes the preview, then leaves search for wherever it was opened from. A menu or dialog
  // takes its own Esc, and a filled box clears itself first.
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="menu"], [role="listbox"], [role="dialog"]')) return;
    if (preview) {
      // Only the preview closes: a search box's own Esc would also clear the query.
      event.preventDefault();
      onPreviewChange(undefined);
      return;
    }
    if (target instanceof HTMLInputElement && target.value) return;
    if (router.history.canGoBack()) router.history.back();
    else void router.navigate({ to: "/messages" });
  });
  useEffect(() => {
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);

  return (
    <SearchPreviewContext.Provider value={previewContext}>
      <main className="flex h-svh min-w-0 bg-primary">
        <div
          className={
            showPreview ? "flex w-[35rem] shrink-0 flex-col" : "flex min-w-0 flex-1 flex-col"
          }
        >
          <PageHeader heading={m.search_title()} />
          <div
            className="border-b border-secondary px-4 py-3 sm:px-6"
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
          >
            <Input
              type="search"
              size="md"
              icon={SearchLg}
              aria-label={m.search_title()}
              placeholder={m.search_placeholder()}
              maxLength={SEARCH_QUERY_MAX_LENGTH}
              ref={input}
              shortcut={shortcut}
              autoFocus
              value={text}
              onChange={setText}
              className="w-full"
            />
            <div className="mt-3">
              <SearchFilterBar
                workspaceId={workspaceId}
                query={committed}
                filters={filters}
                onChange={onFiltersChange}
              />
            </div>
          </div>
          {committed || (hasActiveFilter(filters) && !deferred) ? (
            <SearchResults
              workspaceId={workspaceId}
              timeZone={timeZone}
              query={committed}
              filters={filters}
              onOpen={(entity) => memory.recordOpen(committed, entity)}
              onClear={() => {
                if (committed) {
                  lastCommitted.current = "";
                  setText("");
                  onQueryChange("");
                } else {
                  onFiltersChange(clearedFilters(filters));
                }
                // The button goes away with the results; keep the keyboard in the search box.
                input.current?.focus();
              }}
            />
          ) : (
            <SearchHome
              workspaceId={workspaceId}
              loaded={memory.loaded}
              history={memory.history}
              usage={memory.usage}
              onSearch={(next) => {
                lastCommitted.current = next;
                setText(next);
                onQueryChange(next);
                input.current?.focus();
              }}
              onRemoveSearch={(entry) => {
                memory.removeSearch(entry);
                // The removed chip took focus with it; keep the keyboard in the search box.
                input.current?.focus();
              }}
              onClearHistory={() => {
                memory.clearHistory();
                input.current?.focus();
              }}
              onOpen={(entity) => memory.recordOpen("", searchEntityKey(entity))}
            />
          )}
        </div>
        {showPreview && preview && (
          <SearchPreview
            key={`${preview.kind}:${preview.id}`}
            target={preview}
            title={previewTitle}
            onOpen={openPreviewed}
            onClose={() => onPreviewChange(undefined)}
          />
        )}
      </main>
    </SearchPreviewContext.Provider>
  );
}

function SearchResults({
  workspaceId,
  timeZone,
  query,
  filters,
  onOpen,
  onClear,
}: {
  workspaceId: string;
  timeZone: string | null;
  query: string;
  filters: SearchFilters;
  /** A result is opening: the place it opens, when it is a channel or an Agent. */
  onOpen: (entity: SearchEntityKey | undefined) => void;
  /** Clears the query, or the filters when there is no query. */
  onClear: () => void;
}) {
  const search = useMessageSearch(workspaceId, query, filters, timeZone);
  const { entities, pending: entitiesPending } = useSearchEntities(workspaceId, query);
  const refreshing = search.isFetching && !search.isFetchingNextPage;
  const hits = search.data?.pages.flatMap((page) => page.results) ?? [];
  const terms = searchTerms(query);

  // Nothing matched only once both the messages and the Workspace lists have loaded.
  const nothingMatched =
    hits.length === 0 && !search.isPending && !search.isError && !entitiesPending;
  if (nothingMatched && entities.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center px-6 pt-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchLg aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {query ? m.search_no_results_title({ query }) : m.search_no_matching_messages()}
            </EmptyTitle>
            <EmptyDescription>
              {query ? m.search_no_results_description() : m.search_try_different_filters()}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" color="secondary" onClick={onClear}>
              {query ? m.search_clear() : m.search_clear_filters()}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={refreshing}>
      {entities.length > 0 && (
        <SearchEntityList
          entities={entities}
          onOpen={(entity) => onOpen(searchEntityKey(entity))}
        />
      )}
      <MessageResults
        search={search}
        hits={hits}
        terms={terms}
        clearLabel={query ? m.search_clear() : m.search_clear_filters()}
        onClear={onClear}
        onOpen={onOpen}
      />
    </div>
  );
}

function useMessageSearch(
  workspaceId: string,
  query: string,
  filters: SearchFilters,
  timeZone: string | null,
) {
  return useInfiniteQuery({
    ...messageSearchQuery(workspaceId, query, filters, timeZone),
    // A changed filter keeps the current rows on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
}

/** The channels, Computers and Agents the query names; none without a query. */
function useSearchEntities(
  workspaceId: string,
  query: string,
): { entities: SearchEntity[]; pending: boolean } {
  const { data: directory, isPending } = useQuery(searchDirectoryQuery(workspaceId));
  // Built once per directory load; each committed query only filters it.
  const candidates = useMemo<SearchEntity[]>(
    () =>
      directory
        ? [
            ...directory.channels.map((channel) => ({ kind: "channel" as const, ...channel })),
            ...directory.computers.map((computer) => ({
              kind: "computer" as const,
              id: computer.id,
              name: computerLabel(computer),
              hostname: computer.name,
              computerKind: computer.kind,
            })),
            ...directory.agents.map((agent) => ({ kind: "agent" as const, ...agent })),
          ]
        : [],
    [directory],
  );
  const entities = useMemo(
    () => (query ? matchSearchEntities(candidates, query) : []),
    [candidates, query],
  );
  // A failed Workspace list only drops this optional section; it is not "no matches".
  return { entities, pending: Boolean(query) && isPending };
}

/** The Messages section: loading, failure, its rows and Load more. */
function MessageResults({
  search,
  hits,
  terms,
  clearLabel,
  onClear,
  onOpen,
}: {
  search: ReturnType<typeof useMessageSearch>;
  hits: MessageSearchHit[];
  terms: string[];
  /** The way out when no message matches: clear the query, or the filters without one. */
  clearLabel: string;
  onClear: () => void;
  onOpen: (entity: SearchEntityKey | undefined) => void;
}) {
  if (search.isPending) {
    return (
      <div
        role="status"
        aria-label={m.search_searching()}
        className="flex flex-col gap-2 p-4 sm:px-6"
      >
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-[4.75rem] rounded-xl" />
        ))}
      </div>
    );
  }

  if (search.isError && hits.length === 0) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 pt-16 text-center">
        <p className="text-sm font-semibold text-primary">{m.search_failed_title()}</p>
        <p className="max-w-sm text-sm text-tertiary">{m.search_failed_description()}</p>
        <Button size="sm" color="secondary" onClick={() => void search.refetch()}>
          {m.search_retry()}
        </Button>
      </div>
    );
  }

  return (
    <section aria-labelledby="search-messages-heading" className="flex flex-col gap-2 p-4 sm:px-6">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="search-messages-heading" className="text-sm font-semibold text-secondary">
          {m.search_messages_heading()}
        </h2>
        {hits.length > 0 && (
          <span role="status" className="text-xs text-tertiary tabular-nums">
            {search.hasNextPage
              ? m.search_results_count_more({ count: hits.length })
              : m.search_results_count({ count: hits.length })}
          </span>
        )}
      </div>
      {hits.length === 0 && (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-tertiary">
          {m.search_no_messages_match()}
          <Button size="sm" color="link-gray" onClick={onClear}>
            {clearLabel}
          </Button>
        </p>
      )}
      {hits.length > 0 && (
        <ol className="flex flex-col gap-2">
          {hits.map((hit) => (
            <SearchResultRow
              key={hit.message.id}
              hit={hit}
              terms={terms}
              onOpen={() => onOpen(conversationKey(hit.conversation))}
            />
          ))}
        </ol>
      )}
      {search.isFetchNextPageError && (
        <p role="alert" className="text-center text-sm text-error-primary">
          {m.search_load_more_failed()}
        </p>
      )}
      {search.hasNextPage && (
        <Button
          size="sm"
          color="secondary"
          className="self-center"
          isLoading={search.isFetchingNextPage}
          onClick={() => void search.fetchNextPage()}
        >
          {search.isFetchNextPageError ? m.search_retry() : m.search_load_more()}
        </Button>
      )}
    </section>
  );
}

/** The remembered place a message result opens: its channel, or its direct conversation's Agent. */
function conversationKey(
  conversation: MessageSearchHit["conversation"],
): SearchEntityKey | undefined {
  if (conversation.channelName) return searchEntityKey({ kind: "channel", id: conversation.id });
  return conversation.directAgent
    ? searchEntityKey({ kind: "agent", id: conversation.directAgent.id })
    : undefined;
}

function SearchResultRow({
  hit,
  terms,
  onOpen,
}: {
  hit: MessageSearchHit;
  terms: string[];
  onOpen: () => void;
}) {
  const { conversation, message } = hit;
  const { previewed, preview } = useSearchPreview();
  const place = conversation.channelName
    ? `#${conversation.channelName}`
    : `@${conversation.directAgent?.displayName ?? message.senderName}`;
  const text = message.body
    ? messagePlainText({ body: message.body, mentions: message.mentions })
    : (message.attachments[0]?.fileName ?? "");
  const target = messagePreviewTarget(conversation, message);
  const onClick = useResultClick({
    onPreview: preview && target ? () => preview(target) : undefined,
    onOpened: onOpen,
  });

  return (
    <li>
      <Link
        {...savedJumpTarget(conversation, message)}
        data-search-message-id={message.id}
        aria-current={target && isPreviewed(previewed, target) ? "true" : undefined}
        onClick={onClick}
        // A middle click opens a new tab without a click event; it is still an open.
        onAuxClick={(event) => event.button === 1 && onOpen()}
        className="block rounded-xl border border-secondary bg-primary p-3 outline-focus-ring transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 aria-[current=true]:border-brand aria-[current=true]:bg-secondary"
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-tertiary">
          <span className="truncate font-medium">{place}</span>
          {message.threadRootId && (
            <span className="inline-flex shrink-0 items-center gap-1 text-quaternary">
              <MessageTextSquare01 aria-hidden="true" className="size-3" />
              {m.conversation_thread()}
            </span>
          )}
          {conversation.archived && (
            <Badge size="sm" color="gray" type="modern">
              {m.search_archived()}
            </Badge>
          )}
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Avatar
              size="xs"
              src={message.senderAvatarUrl ?? null}
              initials={avatarInitial(message.senderName)}
              contentClassName={avatarToneClassName(message.senderName)}
              alt=""
              className="size-4 shrink-0"
            />
            <span className="truncate font-semibold text-secondary">{message.senderName}</span>
          </span>
          <RelativeTime value={message.createdAt} />
        </div>
        <p className="mt-1 line-clamp-2 text-sm leading-5 break-words text-secondary">
          {searchExcerpt(text, terms).map((part, index) =>
            part.match ? (
              <mark
                key={index}
                className="rounded-sm bg-utility-yellow-200 font-semibold text-primary"
              >
                {part.text}
              </mark>
            ) : (
              part.text
            ),
          )}
        </p>
      </Link>
    </li>
  );
}
