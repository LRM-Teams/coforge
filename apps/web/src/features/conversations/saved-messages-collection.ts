import { collectionOptions, type Collection, type DbClient } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";

import type { listSavedMessages } from "./saved-messages.functions";

/** One saved message as the Saved view renders it, keyed by `message.id`. */
export type SavedEntry = Awaited<ReturnType<typeof listSavedMessages>>[number];

/** The viewer's own bookmark write, scoped the way the server authorizes it. */
type SavedMessageTarget = { conversationId: string; messageId: string };

export type SavedMessagesApi = {
  list: () => Promise<SavedEntry[]>;
  save: (target: SavedMessageTarget) => Promise<unknown>;
  unsave: (target: SavedMessageTarget) => Promise<unknown>;
};

/** How long the loader's list counts as fresh, so a server render does not re-read it. */
const LOADER_LIST_FRESH_MS = 30_000;

export const savedMessagesQueryKey = (workspaceId: string) =>
  ["saved-messages", workspaceId] as const;

/**
 * The viewer's Saved list (#127) as a TanStack DB collection: the route loader's list seeds it, a
 * save or unsave changes it at once (optimistic insert/delete) and persists through the Server
 * Functions, a failed write rolls the change back, and a successful one re-reads the list so the
 * server's rows (conversation labels, save time) replace the local guess.
 */
export function savedMessagesCollection(
  workspaceId: string,
  initial: SavedEntry[],
  api: SavedMessagesApi,
) {
  const id = `saved-messages:${workspaceId}`;
  return collectionOptions(id, (client) =>
    queryCollectionOptions<SavedEntry>({
      id,
      queryKey: savedMessagesQueryKey(workspaceId),
      queryFn: () => api.list(),
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      getKey: (saved) => saved.message.id,
      initialData: initial,
      initialDataUpdatedAt: Date.now(),
      staleTime: LOADER_LIST_FRESH_MS,
      onInsert: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map(({ modified }) =>
            api.save({ conversationId: modified.conversation.id, messageId: modified.message.id }),
          ),
        );
      },
      onDelete: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map(({ original }) =>
            api.unsave({
              conversationId: original.conversation.id,
              messageId: original.message.id,
            }),
          ),
        );
      },
    }),
  );
}

export type SavedMessagesCollection = Collection<SavedEntry, string | number>;

/**
 * The Saved collection on `dbClient`, holding the loader's list from the first render: rows seeded
 * at materialization are there synchronously (a server render draws the right stars), while the
 * Query stays fresh for `LOADER_LIST_FRESH_MS`, so starting sync does not re-read it at once.
 * Only the first materialization on a client seeds it; later loader lists arrive through the Query.
 */
export function materializeSavedMessages(
  dbClient: DbClient,
  workspaceId: string,
  initial: SavedEntry[],
  api: SavedMessagesApi,
): SavedMessagesCollection {
  return dbClient.collection(savedMessagesCollection(workspaceId, initial, api), {
    initialData: initial,
  });
}

const newestSaveFirst = (left: SavedEntry, right: SavedEntry) =>
  new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime();

/**
 * The collection as a React external store: `entries()` keeps one snapshot until the collection
 * changes (newest save first, like the server's list), and `has(id)` lets each row subscribe to its
 * own saved state so a toggle re-renders that row only. The collection subscription (which starts
 * its sync) opens with the first listener, so a server render, which never subscribes, reads the
 * seeded rows without starting a Query.
 *
 * `save`/`unsave` notify right after the optimistic write instead of waiting for the collection's
 * change event: TanStack DB 0.9.2 emits none for an optimistic delete of a seeded row until the
 * write persists, which would hold the star until the server answered.
 */
export function savedMessagesStore(collection: SavedMessagesCollection) {
  let entries = [...collection.toArray].sort(newestSaveFirst);
  const listeners = new Set<() => void>();
  let subscription: { unsubscribe: () => void } | undefined;
  const changed = () => {
    entries = [...collection.toArray].sort(newestSaveFirst);
    for (const notify of listeners) notify();
  };
  const afterWrite = (persisted: Promise<void>) => {
    changed();
    // A rollback changes the collection again; show it whether or not an event reports it.
    return persisted.catch((error: unknown) => {
      changed();
      throw error;
    });
  };
  return {
    entries: () => entries,
    has: (messageId: string) => collection.has(messageId),
    subscribe(listener: () => void) {
      listeners.add(listener);
      subscription ??= collection.subscribeChanges(changed);
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        subscription?.unsubscribe();
        subscription = undefined;
      };
    },
    save: (saved: SavedEntry) => afterWrite(saveMessageOptimistically(collection, saved)),
    unsave: (messageId: string) => afterWrite(unsaveMessageOptimistically(collection, messageId)),
  };
}

export type SavedMessagesStore = ReturnType<typeof savedMessagesStore>;

/** Saves at once; resolves when the server has it, rejects (after rolling back) when it fails. */
export async function saveMessageOptimistically(
  collection: SavedMessagesCollection,
  saved: SavedEntry,
) {
  if (collection.has(saved.message.id)) return;
  await collection.insert(saved).isPersisted.promise;
}

/** Unsaves at once; resolves when the server dropped it, rejects (after rolling back) otherwise. */
export async function unsaveMessageOptimistically(
  collection: SavedMessagesCollection,
  messageId: string,
) {
  if (!collection.has(messageId)) return;
  await collection.delete(messageId).isPersisted.promise;
}

type SavedMessage = SavedEntry["message"];

/** A message row as a conversation stream holds it: the Saved entry's fields, some optional. */
type StreamMessage = Pick<
  SavedMessage,
  "id" | "sequence" | "senderKind" | "senderName" | "body" | "attachments"
> &
  Partial<
    Pick<
      SavedMessage,
      | "threadRootId"
      | "senderHandle"
      | "senderAgentId"
      | "senderDeleted"
      | "reactions"
      | "actionCard"
      | "mentions"
    >
  > & {
    senderMemberId?: string | null;
    senderAvatarUrl?: string | null;
    createdAt: Date | string;
  };

/**
 * The Saved entry a save shows at once, from the row being saved. The stream does not know the
 * conversation's label, so the card's channel or DM comes from the server's list, which the
 * collection re-reads once the save lands.
 */
export function optimisticSavedEntry(message: StreamMessage, conversationId: string): SavedEntry {
  return {
    savedAt: new Date(),
    conversation: { id: conversationId, channelName: null, directKey: null },
    message: {
      id: message.id,
      sequence: message.sequence,
      threadRootId: message.threadRootId,
      senderMemberId: message.senderMemberId ?? null,
      senderKind: message.senderKind,
      senderName: message.senderName,
      senderHandle: message.senderHandle,
      senderAgentId: message.senderAgentId,
      senderDeleted: message.senderDeleted ?? false,
      senderAvatarUrl: message.senderAvatarUrl ?? null,
      body: message.body,
      createdAt: new Date(message.createdAt),
      mentions: message.mentions ?? [],
      attachments: message.attachments,
      reactions: message.reactions,
      actionCard: message.actionCard,
    },
  };
}
