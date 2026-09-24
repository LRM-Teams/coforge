import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  Activity,
  AtSign,
  BellOff01,
  Check,
  CheckDone01,
  Hash02,
  Mail01,
  MessageTextSquare01,
} from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Badge } from "#src/components/base/badges/badges";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
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
import {
  markPublicChannelRead,
  markPublicChannelThreadRead,
  setPublicChannelThreadFollowed,
  setPublicConversationUnread,
} from "#src/features/conversations/channels.functions";
import {
  markDirectConversationRead,
  markDirectThreadRead,
  setDirectConversationUnread,
} from "#src/features/conversations/conversations.functions";
import { MessagePreview } from "#src/features/conversations/message-preview";
import {
  useRefreshSidebarLists,
  useSidebarActions,
} from "#src/features/conversations/sidebar-lists";
import { TASK_STATUS_COLOR } from "#src/features/tasks/task-workflow";
import { cn } from "#src/lib/utils";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { markActivityInboxRead, markActivityItemDone } from "./activity-inbox.functions";
import { useActivityInboxRealtime } from "./use-activity-inbox-realtime";
import {
  ACTIVITY_INBOX_QUERY_PREFIX,
  activityInboxQuery,
  type ActivityInboxPage,
} from "./activity-inbox-queries";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

const appRoute = getRouteApi("/_app");

/**
 * The Activity page: the viewer's channels, direct messages and followed threads with activity
 * they have not marked Done, newest first. A card opens its conversation or thread and reads it;
 * the check on a card marks it Done, which keeps it away until a newer message arrives.
 */
export function ActivityInboxView({
  filter,
  onFilterChange,
}: {
  filter: ActivityInboxFilter;
  onFilterChange: (filter: ActivityInboxFilter) => void;
}) {
  const { user, currentWorkspace } = appRoute.useLoaderData();
  const workspaceId = currentWorkspace?.id ?? "";
  const queryClient = useQueryClient();
  const markAllRead = useServerFn(markActivityInboxRead);

  // Switching views keeps the current cards on screen until the next view has loaded.
  const query = useInfiniteQuery({
    ...activityInboxQuery(workspaceId, filter),
    placeholderData: keepPreviousData,
  });

  // Pages are offsets into a list that can move between fetches; an item that slid onto the next
  // page is shown once.
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((item) => !seen.has(item.key) && seen.add(item.key));
  }, [query.data]);
  const totals = query.data?.pages[0];

  const refreshList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_QUERY_PREFIX }),
    [queryClient],
  );
  // A read here also changes the Chat sidebar's badges.
  const refreshSidebar = useRefreshSidebarLists();
  const refresh = useCallback(
    () => Promise.all([refreshList(), refreshSidebar()]).then(() => undefined),
    [refreshList, refreshSidebar],
  );
  useActivityInboxRealtime({ workspaceId, userId: user.id, onActivity: refreshList });

  // A failed change is shown in the toolbar with its retry until it succeeds or is dismissed.
  const [failure, setFailure] = useState<{ retry: () => void } | null>(null);
  const actions = useActivityItemActions({ onChanged: refresh, onFailure: setFailure });

  // Reads only what the list showed: the server's own clock at the time it read the list.
  const loadedAt = totals?.loadedAt;
  const readAll = useCallback(() => {
    if (loadedAt === undefined) return;
    const run = () => {
      setFailure(null);
      void markAllRead({ data: { before: loadedAt } })
        .catch(() => setFailure({ retry: run }))
        .finally(refresh);
    };
    run();
  }, [markAllRead, loadedAt, refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        heading={m.navigation_activity()}
        meta={
          totals ? (
            <span className="shrink-0 truncate text-sm text-tertiary">
              {m.activity_inbox_active({ count: totals.totalCount })}
              {totals.totalUnreadCount > 0 &&
                ` · ${m.activity_inbox_unread({ count: totals.totalUnreadCount })}`}
            </span>
          ) : undefined
        }
      />
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-secondary px-4 sm:px-6">
        <ButtonGroup
          aria-label={m.activity_inbox_filter_label()}
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[filter]}
          onSelectionChange={(keys) => {
            const [next] = [...keys];
            if (next === "all" || next === "unread" || next === "mentions") onFilterChange(next);
          }}
        >
          <ButtonGroupItem id="all">{m.activity_inbox_filter_all()}</ButtonGroupItem>
          <ButtonGroupItem id="unread">{m.activity_inbox_filter_unread()}</ButtonGroupItem>
          <ButtonGroupItem id="mentions">{m.activity_inbox_filter_mentions()}</ButtonGroupItem>
        </ButtonGroup>
        {totals && totals.totalUnreadCount > 0 && (
          <Button size="sm" color="secondary" iconLeading={CheckDone01} onClick={readAll}>
            {m.activity_inbox_mark_all_read()}
          </Button>
        )}
      </div>
      {failure && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-secondary px-4 py-2 text-sm text-error-primary sm:px-6"
        >
          <span className="min-w-0 flex-1">{m.activity_inbox_action_error()}</span>
          <Button size="sm" color="link-gray" onClick={failure.retry}>
            {m.activity_inbox_retry()}
          </Button>
          <Button size="sm" color="link-gray" onClick={() => setFailure(null)}>
            {m.activity_inbox_dismiss()}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
        {query.isError && items.length === 0 ? (
          <ActivityInboxLoadError onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <ActivityInboxEmpty filter={filter} onShowAll={() => onFilterChange("all")} />
        ) : (
          <ol className="flex flex-col gap-2">
            {items.map((item) => (
              <ActivityInboxCard key={item.key} item={item} filter={filter} actions={actions} />
            ))}
          </ol>
        )}
        <ActivityInboxLoadMore
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          failed={query.isFetchNextPageError}
          fetchNextPage={query.fetchNextPage}
        />
      </div>
    </div>
  );
}

/**
 * Asks for the next page as the end of the list scrolls into view. A failed page stops asking and
 * offers a retry instead, so a broken request is never repeated in a loop.
 */
function ActivityInboxLoadMore({
  hasNextPage,
  isFetchingNextPage,
  failed,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  failed: boolean;
  fetchNextPage: () => Promise<unknown>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const waiting = hasNextPage && !isFetchingNextPage && !failed;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !waiting) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [waiting, fetchNextPage]);
  if (!hasNextPage) return null;
  return (
    <div ref={sentinel} className="flex items-center justify-center gap-2 py-3 text-xs">
      {failed ? (
        <>
          <span className="text-error-primary">{m.activity_inbox_load_more_error()}</span>
          <Button size="sm" color="link-gray" onClick={() => void fetchNextPage()}>
            {m.activity_inbox_retry()}
          </Button>
        </>
      ) : isFetchingNextPage ? (
        <span className="text-tertiary">{m.activity_inbox_loading_more()}</span>
      ) : null}
    </div>
  );
}

type ActivityItemActions = ReturnType<typeof useActivityItemActions>;

/**
 * What a card can do. Reading, marking unread and following reuse the conversation's own
 * functions, so the Chat sidebar and the inbox move the same cursors. Done hides the card at once
 * and the refetch puts it back if the server refused. The returned object is stable, so cards
 * re-render only when their own item changes.
 */
function useActivityItemActions({
  onChanged,
  onFailure,
}: {
  onChanged: () => Promise<void>;
  onFailure: (failure: { retry: () => void } | null) => void;
}) {
  const queryClient = useQueryClient();
  const markChannelRead = useServerFn(markPublicChannelRead);
  const markChannelThreadRead = useServerFn(markPublicChannelThreadRead);
  const markDirectRead = useServerFn(markDirectConversationRead);
  const markDirectThread = useServerFn(markDirectThreadRead);
  // The Chat sidebar's optimistic actions; `undefined` where the sidebar is not mounted, which
  // is every page except Chat (so the Activity page saves through the Server Functions below).
  const sidebar = useSidebarActions();
  const setChannelUnread = useServerFn(setPublicConversationUnread);
  const setDirectUnread = useServerFn(setDirectConversationUnread);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const markDone = useServerFn(markActivityItemDone);

  return useMemo(() => {
    function run(action: () => Promise<unknown>) {
      onFailure(null);
      // Through a resolved promise, so an action that throws before it returns a promise is
      // reported like one that rejects.
      void Promise.resolve()
        .then(action)
        .catch(() => onFailure({ retry: () => run(action) }))
        .finally(onChanged);
    }

    function read({ place, thread, latestSequence: throughSequence }: ActivityInboxItem) {
      if (thread) {
        const threadRootId = thread.root.id;
        return place.kind === "channel"
          ? markChannelThreadRead({
              data: { channelId: place.conversationId, threadRootId, throughSequence },
            })
          : markDirectThread({ data: { agentId: place.agent.id, threadRootId, throughSequence } });
      }
      return place.kind === "channel"
        ? markChannelRead({ data: { channelId: place.conversationId, throughSequence } })
        : markDirectRead({ data: { agentId: place.agent.id, throughSequence } });
    }

    return {
      read: (item: ActivityInboxItem) => run(() => read(item)),
      // The sidebar's optimistic collections are live only on the Chat page; here the change is
      // saved directly and the refresh brings the sidebar's badge along.
      unread: ({ place }: ActivityInboxItem) =>
        run(() =>
          // The Chat sidebar's collections are live only there; when they are mounted its own
          // action moves the badge at once, and otherwise (this page) the change is saved
          // directly and the refresh brings the sidebar's badge along.
          sidebar
            ? sidebar.markUnread(
                place.kind === "channel"
                  ? { kind: "channel", channelId: place.conversationId }
                  : { kind: "direct", agentId: place.agent.id },
              )
            : place.kind === "channel"
              ? setChannelUnread({ data: { channelId: place.conversationId, unread: true } })
              : setDirectUnread({ data: { agentId: place.agent.id, unread: true } }),
        ),
      unfollow: ({ place, thread }: ActivityInboxItem) => {
        if (!thread) return;
        run(() =>
          setThreadFollowed({
            data: {
              channelId: place.conversationId,
              threadRootId: thread.root.id,
              followed: false,
            },
          }),
        );
      },
      done: (item: ActivityInboxItem) => {
        queryClient.setQueriesData<InfiniteData<ActivityInboxPage>>(
          { queryKey: ACTIVITY_INBOX_QUERY_PREFIX },
          (data) => data && withoutItem(data, item),
        );
        run(() =>
          markDone({
            data: item.thread
              ? {
                  kind: "thread",
                  conversationId: item.place.conversationId,
                  rootMessageId: item.thread.root.id,
                  throughSequence: item.latestSequence,
                }
              : {
                  kind: "conversation",
                  conversationId: item.place.conversationId,
                  throughSequence: item.latestSequence,
                },
          }),
        );
      },
    };
  }, [
    queryClient,
    onChanged,
    onFailure,
    markChannelRead,
    markChannelThreadRead,
    markDirectRead,
    markDirectThread,
    sidebar,
    setChannelUnread,
    setDirectUnread,
    setThreadFollowed,
    markDone,
  ]);
}

/** A cached view with one item removed and its totals adjusted, until the refetch lands. */
function withoutItem(
  data: InfiniteData<ActivityInboxPage>,
  item: ActivityInboxItem,
): InfiniteData<ActivityInboxPage> {
  if (!data.pages.some((page) => page.items.some((entry) => entry.key === item.key))) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((entry) => entry.key !== item.key),
      totalCount: Math.max(0, page.totalCount - 1),
      totalUnreadCount: Math.max(0, page.totalUnreadCount - item.unreadCount),
    })),
  };
}

/**
 * Where a card goes. A thread opens in its pane beside its root, scrolled to the first unread
 * reply; a conversation opens at its first unread message, or its newest one when everything is
 * read.
 */
function openTarget({
  place,
  thread,
  unreadCount,
  firstUnreadMessageId,
  latest,
}: ActivityInboxItem) {
  const unreadAnchor = unreadCount > 0 ? firstUnreadMessageId : null;
  const search = thread
    ? { threadRootId: thread.root.id, message: thread.root.id }
    : { message: unreadAnchor ?? latest.id };
  const hash = thread && unreadAnchor ? `message-${unreadAnchor}` : undefined;
  return place.kind === "channel"
    ? {
        to: "/messages/channels/$channelId" as const,
        params: { channelId: place.conversationId },
        search,
        hash,
      }
    : { to: "/messages/$agentId" as const, params: { agentId: place.agent.id }, search, hash };
}

/** A message's text rendered as inline Markdown, or its first attachment's name. */
function Preview({ message }: { message: ActivityInboxItem["latest"] }) {
  if (message.body) return <MessagePreview body={message.body} mentions={message.mentions} />;
  return <>{message.attachments[0]?.fileName ?? ""}</>;
}

const ActivityInboxCard = memo(function ActivityInboxCard({
  item,
  filter,
  actions,
}: {
  item: ActivityInboxItem;
  filter: ActivityInboxFilter;
  actions: ActivityItemActions;
}) {
  const router = useRouter();
  const target = openTarget(item);
  const href = router.buildLocation(target).publicHref;
  const unread = item.unreadCount > 0;
  const { place, thread } = item;
  const placeName =
    place.kind === "channel" ? `#${place.channelName}` : `@${place.agent.displayName}`;
  const sender =
    item.latest.senderKind === "system" ? m.activity_inbox_system_sender() : item.latest.senderName;

  function handleAction(key: unknown) {
    if (key === "read") actions.read(item);
    else if (key === "unread") actions.unread(item);
    else if (key === "done") actions.done(item);
    else if (key === "unfollow") actions.unfollow(item);
  }

  return (
    <li className="group relative flex items-start gap-2 rounded-xl border border-secondary bg-primary p-3 transition-colors select-none [-webkit-touch-callout:none] hover:bg-secondary">
      {/* The card is a React Aria link so the context menu (`MenuTrigger trigger="contextMenu"`)
          can use it as its trigger; `render` hands the element to TanStack's `Link`, which owns
          navigation. Opening a card reads it, like opening the conversation does. */}
      <Dropdown.Root trigger="contextMenu">
        <AriaLink
          href={href}
          onPress={() => {
            if (unread) actions.read(item);
          }}
          render={(props) =>
            "href" in props ? <Link {...props} {...target} /> : <span {...props} />
          }
          className="min-w-0 flex-1 rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {thread && (
            <p className="mb-0.5 truncate text-xs font-medium text-tertiary">{placeName}</p>
          )}
          <div className="flex min-w-0 items-start gap-2">
            <ActivityItemIcon item={item} />
            <p
              className={cn(
                "line-clamp-2 min-w-0 flex-1 text-sm break-words",
                unread ? "font-semibold text-primary" : "font-medium text-secondary",
              )}
            >
              {thread ? <Preview message={thread.root} /> : placeName}
            </p>
            <RelativeTime
              value={item.latest.createdAt}
              plain
              className="shrink-0 text-xs text-quaternary"
            />
          </div>
          <p
            className={cn(
              "mt-1 line-clamp-2 text-sm break-words",
              unread ? "text-secondary" : "text-tertiary",
            )}
          >
            <span className="font-medium">{sender}: </span>
            <Preview message={item.latest} />
          </p>
          <ActivityItemBadges item={item} filter={filter} />
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu aria-label={m.activity_inbox_menu_label()} onAction={handleAction}>
            {unread ? (
              // Keyed by id: React Aria refuses an item whose id changes in place, which happens
              // when a read or unread lands while the menu is still closing.
              <Dropdown.Item
                key="read"
                id="read"
                icon={Mail01}
                label={m.activity_inbox_mark_read()}
                selectionIndicator="none"
              />
            ) : thread ? null : (
              <Dropdown.Item
                key="unread"
                id="unread"
                icon={Mail01}
                label={m.conversation_menu_mark_unread()}
                selectionIndicator="none"
              />
            )}
            <Dropdown.Item
              id="done"
              icon={Check}
              label={m.activity_inbox_menu_done()}
              selectionIndicator="none"
            />
            {thread && place.kind === "channel" && (
              <Dropdown.Item
                id="unfollow"
                icon={BellOff01}
                label={m.conversation_thread_unfollow()}
                selectionIndicator="none"
              />
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ButtonUtility
        icon={Check}
        size="xs"
        color="tertiary"
        tooltip={m.activity_inbox_done()}
        aria-label={m.activity_inbox_done()}
        onClick={() => actions.done(item)}
        className="shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      />
    </li>
  );
});

function ActivityItemIcon({ item }: { item: ActivityInboxItem }) {
  if (!item.thread && item.place.kind === "direct")
    return (
      <Avatar
        size="xs"
        src={item.place.agent.avatarUrl}
        alt=""
        className="mt-0.5 size-4 shrink-0"
      />
    );
  const Icon = item.thread ? MessageTextSquare01 : Hash02;
  return <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-quaternary" />;
}

function ActivityItemBadges({
  item,
  filter,
}: {
  item: ActivityInboxItem;
  filter: ActivityInboxFilter;
}) {
  const { thread } = item;
  const showMention = filter !== "mentions" && item.unreadMention;
  if (!thread && !showMention && item.unreadCount === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {thread?.task && (
        <Badge type="color" size="sm" color={TASK_STATUS_COLOR[thread.task.status].badge}>
          #{thread.task.number}
          {thread.task.ownerName ? ` @${thread.task.ownerName}` : ""}
        </Badge>
      )}
      {thread?.task?.ownerDeleted && <DeletedAgentBadge />}
      {thread && (
        <Badge type="modern" size="sm" color="gray">
          {m.activity_inbox_replies({ count: thread.replyCount })}
        </Badge>
      )}
      {showMention && (
        <Badge type="color" size="sm" color="brand">
          @{m.activity_inbox_mention_badge()}
        </Badge>
      )}
      {item.unreadCount > 0 && (
        <Badge type="color" size="sm" color="brand">
          {m.activity_inbox_new({ count: item.unreadCount })}
        </Badge>
      )}
    </div>
  );
}

function ActivityInboxEmpty({
  filter,
  onShowAll,
}: {
  filter: ActivityInboxFilter;
  onShowAll: () => void;
}) {
  const title =
    filter === "mentions"
      ? m.activity_inbox_empty_mentions_title()
      : filter === "unread"
        ? m.activity_inbox_empty_unread_title()
        : m.activity_inbox_empty_title();
  const description =
    filter === "mentions"
      ? m.activity_inbox_empty_mentions_description()
      : m.activity_inbox_empty_description();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {filter === "mentions" ? (
              <AtSign aria-hidden="true" />
            ) : (
              <Activity aria-hidden="true" />
            )}
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {filter !== "all" && (
          <EmptyContent>
            <Button size="sm" color="secondary" onClick={onShowAll}>
              {m.activity_inbox_show_all()}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}

function ActivityInboxLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{m.activity_inbox_load_error()}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" color="secondary" onClick={onRetry}>
            {m.activity_inbox_retry()}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/** The Activity page while its first page loads (the route's pending fallback). */
export function ActivityInboxPending() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={m.activity_inbox_loading()}
      className="flex h-full min-h-0 flex-col"
    >
      <PageHeader heading={m.navigation_activity()} />
      <ol className="flex flex-col gap-2 p-4 sm:px-6">
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className="rounded-xl border border-secondary p-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="mt-2 h-4 w-3/4" />
          </li>
        ))}
      </ol>
    </div>
  );
}
