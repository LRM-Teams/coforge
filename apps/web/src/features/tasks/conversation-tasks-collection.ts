import type { QueryClient } from "@tanstack/react-query";
import { createCollection, type ChangeMessage, type LoadSubsetOptions } from "@tanstack/react-db";
import { parseLoadSubsetOptions, queryCollectionOptions } from "@tanstack/query-db-collection";
import { createStore } from "@tanstack/react-store";
import {
  TASK_REFERENCE_TOKEN_PATTERN,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";

import {
  CONVERSATION_TASK_NUMBERS_MAX,
  type ConversationTask,
  type ConversationTaskSubset,
} from "./conversation-task-subset";
import { createAnnouncedTasks } from "./announced-tasks";
import { isFinishedStatus } from "./finished-tasks";
import { loadConversationTasks } from "./tasks.functions";

// A conversation's Tasks as a TanStack DB Query Collection in on-demand mode, one per conversation
// (the business scope): nothing is read until a live query over it asks, and each live query's
// predicate becomes the read — the Tasks tab's unfinished Tasks, the Tasks of the message window,
// the Tasks its bodies name. https://tanstack.com/db/latest/docs/collections/query-collection

/** The server call the collection makes; tests pass their own. */
export type ConversationTasksApi = {
  load: (
    conversationId: string,
    subset: ConversationTaskSubset,
  ) => Promise<{ tasks: ConversationTask[] }>;
};

const serverConversationTasksApi: ConversationTasksApi = {
  load: (conversationId, subset) => loadConversationTasks({ data: { conversationId, ...subset } }),
};

/** Every Query key the collection reads under starts with this one, so invalidating it reads each
 * subset a page still shows again. */
export const conversationTasksKey = (conversationId: string) =>
  ["conversation", "tasks", conversationId] as const;

/**
 * A live query's predicate as the read it asks for. Only what the server answers is accepted —
 * `status` and `number` in (or equal to) some values, `sequence` from and through a bound — so a
 * predicate it could not answer fails rather than reading more than was asked.
 */
function conversationTaskSubset(options: LoadSubsetOptions | undefined) {
  const { filters, limit } = parseLoadSubsetOptions(options);
  if (limit !== undefined) throw new Error("A conversation's Tasks are read without a limit");
  const subset: ConversationTaskSubset = {};
  for (const { field, operator, value } of filters) {
    const name = field.join(".");
    const values = operator === "eq" ? [value] : operator === "in" ? (value as unknown[]) : null;
    if (name === "status" && values) subset.statuses = values as TaskStatus[];
    else if (name === "number" && values) subset.numbers = values as number[];
    else if (name === "sequence" && operator === "gte") subset.sequenceFrom = value as number;
    else if (name === "sequence" && operator === "lte") subset.sequenceTo = value as number;
    else throw new Error(`A conversation's Tasks cannot be read by ${name} ${operator}`);
  }
  if (Object.keys(subset).length === 0)
    throw new Error("A conversation's Tasks are never read all at once");
  return subset;
}

/** The task numbers one body names, read once per message object. */
const referencesByMessage = new WeakMap<object, readonly number[]>();
function referencedNumbers(message: { body: string }) {
  let numbers = referencesByMessage.get(message);
  if (!numbers) {
    numbers = [...message.body.matchAll(TASK_REFERENCE_TOKEN_PATTERN)].map((match) =>
      Number(match[1]),
    );
    referencesByMessage.set(message, numbers);
  }
  return numbers;
}

/**
 * What a loaded message window asks of its conversation's Tasks: the Tasks of its messages, as the
 * range of their sequences (open at the live end, so a message that arrives later needs no read of
 * its own: its Task is announced), and the Tasks its bodies name by number. Undefined for no
 * messages. Equal windows ask equally, so the same Tasks are never read twice.
 */
export function messageWindowTasks(
  messages: readonly { sequence: number; body: string }[],
  hasNewer: boolean,
) {
  if (messages.length === 0) return undefined;
  let sequenceFrom = Infinity;
  let sequenceTo = -Infinity;
  const numbers = new Set<number>();
  for (const message of messages) {
    sequenceFrom = Math.min(sequenceFrom, message.sequence);
    sequenceTo = Math.max(sequenceTo, message.sequence);
    for (const number of referencedNumbers(message)) numbers.add(number);
  }
  return {
    sequenceFrom,
    ...(hasNewer && { sequenceTo }),
    numbers: [...numbers]
      .sort((left, right) => left - right)
      .slice(0, CONVERSATION_TASK_NUMBERS_MAX),
  };
}

/** Task changes to apply: announced ones (`task.changed.v1`), or a command's own result. */
export type TaskChanges = { tasks: readonly TaskView[]; deleted: readonly string[] };

/** The Tasks the collection holds, by message id and by number, for readers of one Task. */
type HeldConversationTasks = {
  byId: ReadonlyMap<string, ConversationTask>;
  byNumber: ReadonlyMap<number, ConversationTask>;
};

/** A store holding no Tasks: what readers show before the collection has read any. */
export const createHeldTasksStore = () =>
  createStore<HeldConversationTasks>({ byId: new Map(), byNumber: new Map() });

/** A new store state from the collection's changes: unchanged Tasks keep their very objects. */
function heldAfter(
  held: HeldConversationTasks,
  changes: readonly ChangeMessage<ConversationTask, string | number>[],
): HeldConversationTasks {
  const byId = new Map(held.byId);
  const byNumber = new Map(held.byNumber);
  for (const { type, value } of changes) {
    const known = byId.get(value.messageId);
    if (known && byNumber.get(known.number) === known) byNumber.delete(known.number);
    if (type === "delete") byId.delete(value.messageId);
    else {
      byId.set(value.messageId, value);
      byNumber.set(value.number, value);
    }
  }
  return { byId, byNumber };
}

/**
 * How long a live query's read stays held after nothing shows it: a window that moves keeps the
 * Tasks it showed until the next window's read has answered, rather than blanking their badges.
 */
export const DEMAND_GC_TIME_MS = 10_000;
/** A remount or focus within a few seconds of a read does not read again. */
const READ_STALE_TIME_MS = 5_000;

export function createConversationTasks(
  queryClient: QueryClient,
  conversationId: string,
  api: ConversationTasksApi = serverConversationTasksApi,
) {
  // A read that started before a change must not put the older copy, or a deleted Task, back:
  // each read is complete for its own subset, so this is the only thing that could.
  const announced = createAnnouncedTasks();

  const collection = createCollection(
    queryCollectionOptions({
      id: `conversation-tasks:${conversationId}`,
      queryKey: conversationTasksKey(conversationId),
      syncMode: "on-demand",
      queryFn: async (context) =>
        (
          await api.load(
            conversationId,
            conversationTaskSubset(context.meta?.loadSubsetOptions as LoadSubsetOptions),
          )
        ).tasks,
      select: announced.over,
      queryClient,
      getKey: (row: ConversationTask) => row.messageId,
      staleTime: READ_STALE_TIME_MS,
      // The one safety net besides the announcements: a focus reads each shown subset again.
      refetchOnWindowFocus: true,
    }),
  );

  const store = createHeldTasksStore();
  // One subscription for every reader; it starts the collection's sync (no read happens until a
  // live query asks) and keeps it for as long as the conversation's page is known.
  collection.subscribeChanges((changes) => store.setState((held) => heldAfter(held, changes)), {
    includeInitialState: false,
  });

  /**
   * Writes changes into the collection in one write, in order: a newer copy replaces its Task (a
   * held Task keeps its read `sequence`), an unknown Task joins, a deleted one leaves; a copy no
   * newer than the one held (the echo of a change already taken) changes nothing. Returns whether
   * Done or Closed may have changed — the server counts and pages those, so only then are their
   * reads needed again. The collection holds only what the page shows, so a Task it does not
   * hold may have been finished: a copy of one that changed before (`revision` above 0) or its
   * deletion counts as a change there.
   */
  const apply = (bursts: readonly TaskChanges[]) => {
    const next = new Map<string, TaskView | null>();
    const current = (messageId: string) =>
      next.has(messageId) ? (next.get(messageId) ?? undefined) : collection.get(messageId);
    let finishedChanged = false;
    for (const { tasks, deleted } of bursts) {
      for (const copy of tasks) {
        const held = current(copy.messageId);
        if (held && copy.revision <= held.revision) continue;
        if (
          isFinishedStatus(copy.status) ||
          (held ? isFinishedStatus(held.status) : copy.revision > 0)
        )
          finishedChanged = true;
        next.set(copy.messageId, copy);
        announced.changed(copy);
      }
      for (const messageId of deleted) {
        const held = current(messageId);
        if (!held || isFinishedStatus(held.status)) finishedChanged = true;
        next.set(messageId, null);
        announced.deleted(messageId);
      }
    }
    const writes = [...next].filter(([messageId, copy]) => copy || collection.has(messageId));
    if (writes.length > 0)
      collection.utils.writeBatch(() => {
        for (const [messageId, copy] of writes) {
          if (!copy) collection.utils.writeDelete(messageId);
          else if (collection.has(messageId)) collection.utils.writeUpdate({ ...copy });
          else collection.utils.writeInsert({ ...copy });
        }
      });
    return { finishedChanged };
  };

  return { collection, store, apply };
}

export type ConversationTasks = ReturnType<typeof createConversationTasks>;
