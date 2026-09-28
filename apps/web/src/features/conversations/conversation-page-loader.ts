import type { QueryClient } from "@tanstack/react-query";

import type { FinishedWindow } from "#src/features/tasks/finished-tasks";
import { finishedSummaryQuery } from "#src/features/tasks/use-finished-tasks";
import type { ConversationTab } from "./conversation-tabs";
import {
  directConversationQuery,
  ensureConversationWindow,
  publicChannelQuery,
} from "./conversation-queries";

/** Which conversation a page shows: a channel, or the direct conversation with an Agent. */
export type ConversationPageTarget = { kind: "channel" | "agent"; id: string };

/**
 * What a conversation page's loader depends on, from its host's address: the message it lands on
 * (an open thread's root, else the jump target) and, on the Tasks tab, the finished-work window
 * whose counts it reads.
 */
export function conversationPageLoaderDeps(search: {
  message?: string;
  threadRootId?: string;
  view?: ConversationTab;
  completed?: Exclude<FinishedWindow, "week">;
}) {
  return {
    anchor: search.threadRootId ?? search.message,
    tasks: search.view === "tasks" ? (search.completed ?? "week") : undefined,
  } as const;
}

/**
 * Reads what a conversation page shows first, as every host (Chat's routes, the search preview)
 * opens it: the window around the anchor, then the Tasks tab's finished-work counts.
 */
export async function loadConversationPage(
  queryClient: QueryClient,
  target: ConversationPageTarget,
  deps: ReturnType<typeof conversationPageLoaderDeps>,
  {
    cause,
    workspaceId,
  }: { cause: "preload" | "enter" | "stay"; workspaceId: () => Promise<string> },
): Promise<void> {
  const window =
    target.kind === "channel"
      ? await ensureConversationWindow(
          queryClient,
          publicChannelQuery(target.id).query,
          deps.anchor,
        )
      : await ensureConversationWindow(
          queryClient,
          directConversationQuery(target.id).query,
          deps.anchor,
        );
  const conversationId = window.pages.at(-1)?.conversationId;
  if (!deps.tasks || !conversationId) return;
  const completedWindow = deps.tasks;
  const summary = workspaceId().then((workspaceId) =>
    queryClient.ensureQueryData(
      finishedSummaryQuery({ workspaceId, conversationId }, completedWindow),
    ),
  );
  // Arriving from another kind of page (`enter`: a first load, or from a channel to a direct
  // message and back) waits for the counts. Staying on this kind of page (`stay`: switching to
  // the Tasks tab, changing the window, or opening another conversation of the same kind) only
  // starts the read: the board shows its loading state until the counts arrive
  // (`finished.pending`), so the page never gives way to its loading page for them.
  if (cause === "stay") void summary.catch(() => undefined);
  else await summary;
}
