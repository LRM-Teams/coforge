import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessageTextSquare01, SearchLg } from "@untitledui/icons";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { PageHeader } from "#src/components/layout/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { RelativeTime } from "#src/components/ui/relative-time";
import { Skeleton } from "#src/components/ui/skeleton";
import { savedJumpTarget } from "#src/features/conversations/saved-messages-model";
import { messagePlainText } from "#src/features/conversations/selection-copy";
import { searchTerms } from "#src/lib/search-terms";
import { m } from "#src/paraglide/messages";
import type { MessageSearchHit } from "#src/server/conversations/message-search.server";
import { searchExcerpt } from "./search-excerpt";
import { messageSearchQuery } from "./search-queries";
import { SEARCH_QUERY_MAX_LENGTH } from "./search.schemas";

/** Pause in typing before the query is committed to the URL and searched. */
const COMMIT_DELAY_MS = 200;

/**
 * The Workspace search page. The query lives in the URL (`?q=`), so a search can be shared,
 * reloaded, and returned to with Back; typing commits it after a short pause, and never while an
 * input method is still composing. Clicking a result opens its conversation at that message.
 */
export function SearchPage({
  workspaceId,
  query,
  onQueryChange,
}: {
  workspaceId: string;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const [text, setText] = useState(query);
  const composing = useRef(false);
  const committed = query.trim();

  // Back/forward or a link can change `q` under the input; show what is being searched.
  useEffect(() => setText(query), [query]);

  useEffect(() => {
    if (composing.current || text === query) return;
    const timer = setTimeout(() => onQueryChange(text), COMMIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, query, onQueryChange]);

  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader heading={m.search_title()} />
      <div
        className="border-b border-secondary px-4 py-3 sm:px-6"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          setText(event.currentTarget.querySelector("input")?.value ?? text);
        }}
      >
        <Input
          type="search"
          size="md"
          icon={SearchLg}
          aria-label={m.search_title()}
          placeholder={m.search_placeholder()}
          maxLength={SEARCH_QUERY_MAX_LENGTH}
          autoFocus
          value={text}
          onChange={setText}
          className="w-full"
        />
      </div>
      {committed ? (
        <SearchResults workspaceId={workspaceId} query={committed} />
      ) : (
        <div className="flex min-h-0 flex-1 items-start justify-center px-6 pt-16">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchLg aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{m.search_empty_title()}</EmptyTitle>
              <EmptyDescription>{m.search_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      )}
    </main>
  );
}

function SearchResults({ workspaceId, query }: { workspaceId: string; query: string }) {
  const search = useInfiniteQuery(messageSearchQuery(workspaceId, { query }));
  const hits = search.data?.pages.flatMap((page) => page.results) ?? [];
  const terms = searchTerms(query);

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

  if (hits.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center px-6 pt-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchLg aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{m.search_no_results_title({ query })}</EmptyTitle>
            <EmptyDescription>{m.search_no_results_description()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section
        aria-labelledby="search-messages-heading"
        className="flex flex-col gap-2 p-4 sm:px-6"
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="search-messages-heading" className="text-sm font-semibold text-secondary">
            {m.search_messages_heading()}
          </h2>
          <span role="status" className="text-xs text-tertiary">
            {m.search_results_count({ count: hits.length })}
          </span>
        </div>
        <ol className="flex flex-col gap-2">
          {hits.map((hit) => (
            <SearchResultRow key={hit.message.id} hit={hit} terms={terms} />
          ))}
        </ol>
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
    </div>
  );
}

function SearchResultRow({ hit, terms }: { hit: MessageSearchHit; terms: string[] }) {
  const { conversation, message } = hit;
  const place = conversation.channelName
    ? `#${conversation.channelName}`
    : `@${conversation.directAgent?.displayName ?? message.senderName}`;
  const text = message.body
    ? messagePlainText({ body: message.body, mentions: message.mentions })
    : (message.attachments[0]?.fileName ?? "");

  return (
    <li>
      <Link
        {...savedJumpTarget(conversation, message)}
        className="block rounded-xl border border-secondary bg-primary p-3 outline-focus-ring transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
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
