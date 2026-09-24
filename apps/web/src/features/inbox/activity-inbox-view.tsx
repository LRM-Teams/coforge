import { useCallback, useEffect, useMemo, useRef } from "react";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  Activity,
  AtSign,
  Bell01,
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
import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  markPublicChannelRead,
  markPublicChannelThreadRead,
  setPublicChannelThreadFollowed,
  setPublicConversationUnread,
} from "#src/features/conversations/channels.functions";
import {
  decodeMessageAvailableEvent,
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import {
  markDirectConversationRead,
  markDirectThreadRead,
  setDirectConversationUnread,
} from "#src/features/conversations/conversations.functions";
import { messagePlainText } from "#src/features/conversations/selection-copy";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  getUserConversationSubscriptionToken,
  getWorkspaceConversationSubscriptionToken,
} from "#src/features/realtime/realtime.functions";
import { TASK_STATUS_COLOR } from "#src/features/tasks/task-workflow";
import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { cn } from "#src/lib/utils";
import {
  loadActivityInbox,
  markActivityInboxRead,
  markActivityItemDone,
} from "./activity-inbox.functions";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

const appRoute = getRouteApi("/_app");

type ActivityInboxPage = Awaited<ReturnType<typeof loadActivityInbox>>;

/** Every cached page of every view shares this prefix, so one invalidation refreshes them all. */
const ACTIVITY_INBOX_QUERY_PREFIX = ["activity-inbox"] as const;
const activityInboxQueryKey = (workspaceId: string | undefined, filter: ActivityInboxFilter) =>
  [...ACTIVITY_INBOX_QUERY_PREFIX, workspaceId, filter] as const;

/** A burst of messages (an Agent posting several in a row) refreshes the list once. */
const REFRESH_DELAY_MS = 300;

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
  const workspaceId = useCurrentWorkspaceId();
  const { user } = appRoute.useLoaderData();
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const load = useServerFn(loadActivityInbox);
  const markAllRead = useServerFn(markActivityInboxRead);

  const query = useInfiniteQuery({
    queryKey: activityInboxQueryKey(workspaceId, filter),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => load({ data: { filter, offset: pageParam } }),
    getNextPageParam: (last: ActivityInboxPage, pages: ActivityInboxPage[]) =>
      last.hasMore ? pages.reduce((count, page) => count + page.items.length, 0) : undefined,
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

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_QUERY_PREFIX }),
    [queryClient],
  );
  useActivityInboxRealtime({ workspaceId, userId: user.id, onActivity: refresh });

  const actions = useActivityItemActions({ onChanged: refresh });

  function readAll() {
    void markAllRead()
      .catch(() => toast.error(m.activity_inbox_action_error()))
      .finally(refresh);
  }

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage)
        void fetchNextPage();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-secondary px-4 py-3 sm:px-6">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
        {query.isPending ? (
          <ActivityInboxPending />
        ) : query.isError && items.length === 0 ? (
          <ActivityInboxLoadError onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <ActivityInboxEmpty filter={filter} />
        ) : (
          <ol className="flex flex-col gap-2">
            {items.map((item) => (
              <ActivityInboxCard key={item.key} item={item} filter={filter} actions={actions} />
            ))}
          </ol>
        )}
        {hasNextPage && (
          <div ref={loadMoreRef} className="py-3 text-center text-xs text-tertiary">
            {isFetchingNextPage ? m.activity_inbox_loading_more() : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Refreshes the list when a message lands anywhere the viewer can see: the Workspace channel
 * carries every channel message and thread reply, the viewer's own channel their direct
 * messages. Both subscriptions share the Chat sidebar's, so this opens nothing new.
 */
function useActivityInboxRealtime({
  workspaceId,
  userId,
  onActivity,
}: {
  workspaceId: string | undefined;
  userId: string;
  onActivity: () => void;
}) {
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onPublication = useCallback((publication: { data: unknown }) => {
    try {
      decodeMessageAvailableEvent(publication.data);
    } catch {
      // Not a message signal (the user channel also carries notifications).
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onActivityRef.current(), REFRESH_DELAY_MS);
  }, []);

  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    getToken: workspaceId ? getWorkspaceToken : undefined,
    onPublication,
  });
  useRealtimeSubscription({
    channel: userConversationChannel(userId),
    getToken: getUserToken,
    onPublication,
  });
}

type ActivityItemActions = ReturnType<typeof useActivityItemActions>;

/**
 * What a card can do. Reading, marking unread and following reuse the conversation's own
 * functions, so the Chat sidebar and the inbox move the same cursors. Done hides the card at once
 * and puts it back if the server refuses.
 */
function useActivityItemActions({ onChanged }: { onChanged: () => Promise<void> }) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const markChannelRead = useServerFn(markPublicChannelRead);
  const markChannelThreadRead = useServerFn(markPublicChannelThreadRead);
  const markDirectRead = useServerFn(markDirectConversationRead);
  const markDirectThread = useServerFn(markDirectThreadRead);
  const setChannelUnread = useServerFn(setPublicConversationUnread);
  const setDirectUnread = useServerFn(setDirectConversationUnread);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const markDone = useServerFn(markActivityItemDone);

  const run = useCallback(
    (action: () => Promise<unknown>) => {
      void action()
        .catch(() => toast.error(m.activity_inbox_action_error()))
        .finally(onChanged);
    },
    [onChanged, toast],
  );

  const read = useCallback(
    (item: ActivityInboxItem) => {
      const throughSequence = item.latestSequence;
      if (item.kind === "thread") {
        const threadRootId = item.rootMessageId!;
        return item.channelName
          ? markChannelThreadRead({
              data: { channelId: item.conversationId, threadRootId, throughSequence },
            })
          : markDirectThread({ data: { agentId: item.agent!.id, threadRootId, throughSequence } });
      }
      return item.kind === "channel"
        ? markChannelRead({ data: { channelId: item.conversationId, throughSequence } })
        : markDirectRead({ data: { agentId: item.agent!.id, throughSequence } });
    },
    [markChannelRead, markChannelThreadRead, markDirectRead, markDirectThread],
  );

  return {
    read: (item: ActivityInboxItem) => run(() => read(item)),
    unread: (item: ActivityInboxItem) =>
      run(() =>
        item.kind === "channel"
          ? setChannelUnread({ data: { channelId: item.conversationId, unread: true } })
          : setDirectUnread({ data: { agentId: item.agent!.id, unread: true } }),
      ),
    follow: (item: ActivityInboxItem, followed: boolean) =>
      run(() =>
        setThreadFollowed({
          data: { channelId: item.conversationId, threadRootId: item.rootMessageId!, followed },
        }),
      ),
    done: (item: ActivityInboxItem) => {
      queryClient.setQueriesData<InfiniteData<ActivityInboxPage>>(
        { queryKey: ACTIVITY_INBOX_QUERY_PREFIX },
        (data) => data && withoutItem(data, item),
      );
      run(() =>
        markDone({
          data: item.rootMessageId
            ? {
                kind: "thread",
                conversationId: item.conversationId,
                rootMessageId: item.rootMessageId,
                throughSequence: item.latestSequence,
              }
            : {
                kind: "conversation",
                conversationId: item.conversationId,
                throughSequence: item.latestSequence,
              },
        }),
      );
    },
  };
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

/** Where a card goes: a thread opens beside its root; a conversation opens at its first unread
 * message, or its newest one when everything is read. */
function openTarget(item: ActivityInboxItem) {
  if (item.kind === "thread") {
    const search = { threadRootId: item.rootMessageId!, message: item.rootMessageId! };
    return item.channelName
      ? {
          to: "/messages/channels/$channelId" as const,
          params: { channelId: item.conversationId },
          search,
        }
      : { to: "/messages/$agentId" as const, params: { agentId: item.agent!.id }, search };
  }
  const message = (item.unreadCount > 0 && item.firstUnreadMessageId) || item.latest.id;
  return item.kind === "channel"
    ? {
        to: "/messages/channels/$channelId" as const,
        params: { channelId: item.conversationId },
        search: { message },
      }
    : {
        to: "/messages/$agentId" as const,
        params: { agentId: item.agent!.id },
        search: { message },
      };
}

function messagePreview(message: ActivityInboxItem["latest"]) {
  if (message.body) return messagePlainText({ body: message.body, mentions: message.mentions });
  return message.attachments[0]?.fileName ?? "";
}

function ActivityInboxCard({
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
  const place = item.channelName ? `#${item.channelName}` : `@${item.agent?.displayName ?? ""}`;
  const sender =
    item.latest.senderKind === "system" ? m.activity_inbox_system_sender() : item.latest.senderName;

  function handleAction(key: unknown) {
    if (key === "read") actions.read(item);
    else if (key === "unread") actions.unread(item);
    else if (key === "done") actions.done(item);
    else if (key === "follow") actions.follow(item, true);
    else if (key === "unfollow") actions.follow(item, false);
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
          {item.kind === "thread" && (
            <p className="mb-0.5 truncate text-xs font-medium text-tertiary">{place}</p>
          )}
          <div className="flex min-w-0 items-start gap-2">
            <ActivityItemIcon item={item} />
            <p
              className={cn(
                "line-clamp-2 min-w-0 flex-1 text-sm break-words",
                unread ? "font-semibold text-primary" : "font-medium text-secondary",
              )}
            >
              {item.kind === "thread" && item.root ? messagePreview(item.root) : place}
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
            {messagePreview(item.latest)}
          </p>
          <ActivityItemBadges item={item} filter={filter} />
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu aria-label={m.activity_inbox_menu_label()} onAction={handleAction}>
            {unread ? (
              <Dropdown.Item
                id="read"
                icon={Mail01}
                label={m.activity_inbox_mark_read()}
                selectionIndicator="none"
              />
            ) : item.kind === "thread" ? null : (
              <Dropdown.Item
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
            {item.kind === "thread" && item.followed !== null && (
              <Dropdown.Item
                id={item.followed ? "unfollow" : "follow"}
                icon={item.followed ? BellOff01 : Bell01}
                label={
                  item.followed ? m.conversation_thread_unfollow() : m.conversation_thread_follow()
                }
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
}

function ActivityItemIcon({ item }: { item: ActivityInboxItem }) {
  if (item.kind === "direct")
    return (
      <Avatar
        size="xs"
        src={item.agent?.avatarUrl ?? null}
        alt=""
        className="mt-0.5 size-4 shrink-0"
      />
    );
  const Icon = item.kind === "thread" ? MessageTextSquare01 : Hash02;
  return <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-quaternary" />;
}

function ActivityItemBadges({
  item,
  filter,
}: {
  item: ActivityInboxItem;
  filter: ActivityInboxFilter;
}) {
  const task = item.task;
  const showMention = filter !== "mentions" && item.unreadMention;
  if (!task && item.kind !== "thread" && !showMention && item.unreadCount === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {task && (
        <Badge type="color" size="sm" color={TASK_STATUS_COLOR[task.status as TaskStatus].badge}>
          #{task.number}
          {task.ownerName ? ` @${task.ownerName}` : ""}
        </Badge>
      )}
      {item.kind === "thread" && (
        <Badge type="modern" size="sm" color="gray">
          {m.activity_inbox_replies({ count: item.replyCount })}
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

function ActivityInboxEmpty({ filter }: { filter: ActivityInboxFilter }) {
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

function ActivityInboxPending() {
  return (
    <ol role="status" aria-label={m.activity_inbox_loading_more()} className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="rounded-xl border border-secondary p-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2 h-4 w-3/4" />
        </li>
      ))}
    </ol>
  );
}
