/**
 * Messages the composer has handed off but the server has not yet accepted, kept free of React
 * so it can be unit tested.
 *
 * The composer clears and stays editable the moment a message is submitted, so the next one can
 * be typed straight away. That makes this outbox the only holder of a submitted message until the
 * server accepts it: it runs each chat's sends one at a time in submit order (the server numbers
 * messages in arrival order, so back-to-back messages must not swap places), keeps a failed one
 * as unsent with the reason, and keeps both on this device so neither leaving the chat nor
 * reloading the page loses a message. A retry reuses the request id, which the server treats as
 * the same send, so a message the server did accept is never posted twice.
 */
import { isAppError } from "@/lib/app-error";

/** An attachment already uploaded for the message; its id is all a send needs. */
export type OutgoingAttachment = { id: string; fileName: string };

export type OutgoingMessage = {
  localId: string;
  /** The chat (and thread) it was sent from; see `composerDraftKey`. */
  draftKey: string;
  body: string;
  requestId: string;
  asTask: boolean;
  attachments: OutgoingAttachment[];
};

/**
 * Why a message is unsent, in the reader's terms:
 * - `offline`: the request never reached the server;
 * - `unavailable`: the server could not take it just now;
 * - `interrupted`: the page was closed or reloaded while it was on its way, so it may or may not
 *   have arrived (a retry is safe either way);
 * - `denied`: the reader may not post here (any more);
 * - `gone`: the conversation or thread no longer exists;
 * - `rejected`: the server refused the message itself.
 */
export type UnsentReason =
  | "offline"
  | "unavailable"
  | "interrupted"
  | "denied"
  | "gone"
  | "rejected";

/**
 * - `sending`: on its way, shown greyed in the conversation;
 * - `delivered`: the server has it as `messageId` (its realtime signal carried this request id),
 *   and the entry only waits for that message to appear in the loaded conversation;
 * - `unsent`: the send failed, for `reason`.
 */
export type OutboxEntry =
  | (OutgoingMessage & { state: "sending" })
  | (OutgoingMessage & { state: "delivered"; messageId: string })
  | (OutgoingMessage & { state: "unsent"; reason: UnsentReason; errorId?: string });

/** `fetch` rejects with a `TypeError` whose message names the network failure; the wording is the
 * browser's (Chromium, Firefox, Safari). Any other `TypeError` is a bug, not a lost connection. */
const NETWORK_FAILURE_MESSAGES = [
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
];

export function unsentReason(cause: unknown): UnsentReason {
  if (cause instanceof TypeError && NETWORK_FAILURE_MESSAGES.includes(cause.message))
    return "offline";
  if (!isAppError(cause)) return "unavailable";
  switch (cause.code) {
    case "ACCESS_DENIED":
    case "WORKSPACE_REQUIRED":
    case "AGENT_NOT_VISIBLE":
    case "AGENT_DM_RESTRICTED":
      return "denied";
    case "NOT_FOUND":
      return "gone";
    case "INVALID_INPUT":
    case "CONFLICT":
      return "rejected";
    default:
      return "unavailable";
  }
}

/** Whether sending the same message again can succeed; a refusal would only repeat. */
export function unsentReasonAllowsRetry(reason: UnsentReason): boolean {
  return reason === "offline" || reason === "unavailable" || reason === "interrupted";
}

/** Whether putting the message back in the composer to change it can help: not when the
 * conversation is gone, nor when the message may already be in it (retry that instead, safely). */
export function unsentReasonAllowsEdit(reason: UnsentReason): boolean {
  return reason !== "gone" && reason !== "interrupted";
}

/**
 * The composer text after an unsent message is put back for editing: the unsent message
 * first, then whatever has been typed since, so neither is lost.
 */
export function draftWithUnsentMessage(draft: string, unsent: string): string {
  const kept = draft.trim();
  return kept ? `${unsent}\n\n${kept}` : unsent;
}

/** The slice of `Storage` the outbox uses; `localStorage` in the browser. */
export type OutboxStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

export type ComposerOutbox = {
  subscribe(listener: () => void): () => void;
  /** The chat's messages still on their way or unsent, in submit order. The same array is
   * returned until one of them changes, as `useSyncExternalStore` requires. */
  entries(draftKey: string): readonly OutboxEntry[];
  /** Sends once the chat's earlier sends have settled; resolves with the transport's result, or
   * undefined when the message was kept as unsent. When `deliveredMessageId` names the message the
   * result created, the entry stays as `delivered` until that message is on screen and the caller
   * discards it, so the pending copy never disappears before the real one is shown. */
  send<T>(
    message: OutgoingMessage,
    transport: (message: OutgoingMessage) => Promise<T>,
    deliveredMessageId?: (result: T) => string | undefined,
  ): Promise<T | undefined>;
  /** Sends an unsent message again under its original request id. */
  retry<T>(
    localId: string,
    transport: (message: OutgoingMessage) => Promise<T>,
    deliveredMessageId?: (result: T) => string | undefined,
  ): Promise<T | undefined>;
  /** The server stored the send with this request id as `messageId`: whatever this attempt's own
   * response says, the message exists. A request id this page never sent is ignored. */
  acknowledge(requestId: string, messageId: string): void;
  /** Forgets a message: delivered and now shown for real, deleted by the reader, or taken back to
   * edit. */
  discard(localId: string): void;
};

const STORAGE_PREFIX = "coforge.composer-outbox:";

/** The outbox message a `localStorage` key holds, if it is an outbox key. Another tab that
 * delivers or deletes a message removes its key, and this tab then discards its copy too. */
export function outboxLocalIdOfStorageKey(key: string | null): string | undefined {
  return key?.startsWith(STORAGE_PREFIX) ? key.slice(STORAGE_PREFIX.length) : undefined;
}

type StoredEntry = { entry: OutboxEntry; submittedAt: number };

function parseStored(raw: string | null): StoredEntry | undefined {
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw) as StoredEntry;
    const { entry } = stored;
    if (
      typeof stored.submittedAt !== "number" ||
      typeof entry?.localId !== "string" ||
      typeof entry.draftKey !== "string" ||
      typeof entry.body !== "string" ||
      typeof entry.requestId !== "string" ||
      !Array.isArray(entry.attachments)
    )
      return undefined;
    return stored;
  } catch {
    return undefined;
  }
}

export function createComposerOutbox(storage: OutboxStorage | null): ComposerOutbox {
  const stored = new Map<string, StoredEntry>();
  const listeners = new Set<() => void>();
  const snapshots = new Map<string, readonly OutboxEntry[]>();
  const queues = new Map<string, Promise<unknown>>();
  let submitted = 0;

  // Whatever an earlier page left behind. A message that was still on its way then may or may
  // not have arrived; either way nothing is sending it now.
  try {
    const keys: string[] = [];
    for (let index = 0; storage && index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const found = parseStored(storage?.getItem(key) ?? null);
      if (!found) continue;
      const { entry } = found;
      // Delivered: the conversation's history already has it.
      if (entry.state === "delivered") {
        storage?.removeItem(key);
        continue;
      }
      stored.set(entry.localId, {
        submittedAt: found.submittedAt,
        entry:
          entry.state === "sending" ? { ...entry, state: "unsent", reason: "interrupted" } : entry,
      });
      submitted = Math.max(submitted, found.submittedAt);
    }
  } catch {
    // Storage unavailable: the outbox still works for this page.
  }

  function save(value: StoredEntry) {
    stored.set(value.entry.localId, value);
    try {
      storage?.setItem(STORAGE_PREFIX + value.entry.localId, JSON.stringify(value));
    } catch {
      // Private mode or quota: the message is still held for this page.
    }
    changed(value.entry.draftKey);
  }

  function forget(localId: string) {
    const value = stored.get(localId);
    if (!value) return;
    stored.delete(localId);
    try {
      storage?.removeItem(STORAGE_PREFIX + localId);
    } catch {
      // Nothing durable depends on the removal.
    }
    changed(value.entry.draftKey);
  }

  function changed(draftKey: string) {
    snapshots.delete(draftKey);
    for (const listener of listeners) listener();
  }

  /** Runs `transport` after the chat's earlier sends, then settles the entry either way. */
  function dispatch<T>(
    value: StoredEntry,
    transport: (message: OutgoingMessage) => Promise<T>,
    deliveredMessageId?: (result: T) => string | undefined,
  ): Promise<T | undefined> {
    const { entry } = value;
    const message: OutgoingMessage = {
      localId: entry.localId,
      draftKey: entry.draftKey,
      body: entry.body,
      requestId: entry.requestId,
      asTask: entry.asTask,
      attachments: entry.attachments,
    };
    save({ ...value, entry: { ...message, state: "sending" } });
    const previous = queues.get(entry.draftKey) ?? Promise.resolve();
    const result = previous.then(async () => {
      try {
        const delivered = await transport(message);
        const messageId = deliveredMessageId?.(delivered);
        const current = stored.get(message.localId);
        if (messageId && current && current.entry.state !== "delivered")
          save({ ...current, entry: { ...message, state: "delivered", messageId } });
        else if (!messageId) forget(message.localId);
        return delivered;
      } catch (cause) {
        // Deleted (here or in another tab) while this attempt was out: nothing to keep. Already
        // acknowledged by its signal: the message exists whatever this response says.
        const current = stored.get(message.localId);
        if (!current || current.entry.state === "delivered") return undefined;
        const errorId = isAppError(cause) ? cause.errorId : undefined;
        save({
          ...value,
          entry: { ...message, state: "unsent", reason: unsentReason(cause), errorId },
        });
        return undefined;
      }
    });
    queues.set(entry.draftKey, result);
    return result;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    entries(draftKey) {
      let snapshot = snapshots.get(draftKey);
      if (!snapshot) {
        snapshot = [...stored.values()]
          .filter((value) => value.entry.draftKey === draftKey)
          .sort((left, right) => left.submittedAt - right.submittedAt)
          .map((value) => value.entry);
        snapshots.set(draftKey, snapshot);
      }
      return snapshot;
    },
    send(message, transport, deliveredMessageId) {
      submitted += 1;
      return dispatch(
        { entry: { ...message, state: "sending" }, submittedAt: submitted },
        transport,
        deliveredMessageId,
      );
    },
    retry(localId, transport, deliveredMessageId) {
      const value = stored.get(localId);
      if (!value || value.entry.state !== "unsent") return Promise.resolve(undefined);
      return dispatch(value, transport, deliveredMessageId);
    },
    acknowledge(requestId, messageId) {
      for (const value of stored.values()) {
        if (value.entry.requestId !== requestId || value.entry.state === "delivered") continue;
        const { localId, draftKey, body, asTask, attachments } = value.entry;
        save({
          ...value,
          entry: {
            localId,
            draftKey,
            body,
            requestId,
            asTask,
            attachments,
            state: "delivered",
            messageId,
          },
        });
      }
    },
    discard: forget,
  };
}
