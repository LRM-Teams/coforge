import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  createComposerOutbox,
  outboxLocalIdOfStorageKey,
  type ComposerOutbox,
  type OutboxEntry,
  type OutgoingMessage,
} from "./composer-outbox";
import type { PendingAttachment, SentMessage } from "./message-composer";

let deviceOutbox: ComposerOutbox | undefined;

/** The browser's one outbox, shared by every composer and conversation pane so a message outlives
 * the composer that sent it. Never created on the server, where module state would be shared
 * across requests. */
export function deviceComposerOutbox(): ComposerOutbox {
  if (!deviceOutbox) {
    let storage: Storage | null = null;
    try {
      storage = localStorage;
    } catch {
      // Private mode or blocked storage: messages are still held for this page.
    }
    const outbox = createComposerOutbox(storage);
    window.addEventListener("storage", (event) => {
      const localId = outboxLocalIdOfStorageKey(event.key);
      if (localId && event.newValue === null) outbox.discard(localId);
    });
    deviceOutbox = outbox;
  }
  return deviceOutbox;
}

const NO_OUTBOX_ENTRIES: readonly OutboxEntry[] = [];

function subscribeToOutbox(listener: () => void) {
  return deviceComposerOutbox().subscribe(listener);
}

/** One chat's (or thread's) messages still on their way, delivered but not yet shown, or unsent. */
export function useOutboxEntries(draftKey: string): readonly OutboxEntry[] {
  return useSyncExternalStore(
    subscribeToOutbox,
    () => deviceComposerOutbox().entries(draftKey),
    () => NO_OUTBOX_ENTRIES,
  );
}

/** The attachment chips of messages sent from this page, by outbox `localId`, so "Edit" can put
 * them back with their previews. Files cannot be stored, so after a reload an unsent message with
 * attachments can be retried or deleted, not edited. */
const sentChips = new Map<string, PendingAttachment[]>();

/** Messages sent (or retried) from this page whose failure has not been announced yet. A failure
 * is announced to screen readers once, when it happens: not again when its row scrolls back into
 * view or the chat is reopened, and not for a failure restored from an earlier page. */
const unannouncedFailures = new Set<string>();

/** Whether this failure's row should announce itself (see `failureAnnounced`). */
export function failureNeedsAnnouncing(localId: string) {
  return unannouncedFailures.has(localId);
}

/** The failure's row has announced it; later renders of it stay silent. */
export function failureAnnounced(localId: string) {
  unannouncedFailures.delete(localId);
}

export function canEditUnsent(entry: OutboxEntry) {
  return entry.attachments.length === 0 || sentChips.has(entry.localId);
}

/** What a conversation row asks of its chat's composer: take back an unsent message for editing,
 * or just take the focus back after the row's button that held it went away. */
export type ComposerRequest =
  | { kind: "edit"; body: string; requestId: string; asTask: boolean; chips: PendingAttachment[] }
  | { kind: "focus" };

const composerListeners = new Map<string, Set<(request: ComposerRequest) => void>>();

/** Asks the chat's composer; false when none is shown to take the request. */
function askComposer(draftKey: string, request: ComposerRequest) {
  const listeners = composerListeners.get(draftKey);
  for (const listener of listeners ?? []) listener(request);
  return Boolean(listeners?.size);
}

/** Lets the composer for `draftKey` answer its conversation rows (see `ComposerRequest`). */
export function useComposerRequests(
  draftKey: string,
  onRequest: (request: ComposerRequest) => void,
) {
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;
  useEffect(() => {
    let listeners = composerListeners.get(draftKey);
    if (!listeners) composerListeners.set(draftKey, (listeners = new Set()));
    const listener = (request: ComposerRequest) => onRequestRef.current(request);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [draftKey]);
}

/**
 * The send, retry, edit and delete operations of one chat's outbox, bound to that chat's send
 * operation. The composer submits through it; the conversation pane retries, edits and deletes the
 * rows it shows.
 */
export function useMessageOutbox({
  draftKey,
  onSend,
  onCreateTask,
  onSent,
}: {
  draftKey: string;
  onSend: (
    body: string,
    requestId: string,
    attachmentIds?: string[],
  ) => Promise<SentMessage | void>;
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  onSent?: (message: SentMessage) => void;
}) {
  /** Posts one outbox message through this chat's send (or task) operation. */
  function deliver(message: OutgoingMessage) {
    const attachmentIds = message.attachments.map((attachment) => attachment.id);
    return message.asTask && onCreateTask
      ? // Task creation stays single-attachment; the first upload (send order) is used.
        onCreateTask(message.body, message.requestId, attachmentIds[0]).then(() => undefined)
      : onSend(message.body, message.requestId, attachmentIds);
  }

  async function settle(localId: string, sending: Promise<SentMessage | void | undefined>) {
    const sentMessage = await sending;
    if (sentMessage) onSent?.(sentMessage);
    // Only an unsent message can still be edited, so only its chips are worth keeping.
    const entry = deviceComposerOutbox()
      .entries(draftKey)
      .find((candidate) => candidate.localId === localId);
    if (entry?.state !== "unsent") {
      sentChips.delete(localId);
      unannouncedFailures.delete(localId);
    }
  }

  /** The real message a send created, so the pending row stays until that message is shown. */
  const deliveredMessageId = (sent: SentMessage | void | undefined) => sent?.id;

  return {
    send(message: OutgoingMessage, chips: PendingAttachment[]) {
      if (chips.length > 0) sentChips.set(message.localId, chips);
      unannouncedFailures.add(message.localId);
      void settle(
        message.localId,
        deviceComposerOutbox().send(message, deliver, deliveredMessageId),
      );
    },
    retry(entry: OutboxEntry) {
      unannouncedFailures.add(entry.localId);
      askComposer(draftKey, { kind: "focus" });
      // The same request id, so a send the server did accept is not posted twice.
      void settle(
        entry.localId,
        deviceComposerOutbox().retry(entry.localId, deliver, deliveredMessageId),
      );
    },
    discard(entry: OutboxEntry) {
      deviceComposerOutbox().discard(entry.localId);
      sentChips.delete(entry.localId);
    },
    /** Deleted by the reader: the row and its button go, the focus returns to the composer. */
    remove(entry: OutboxEntry) {
      deviceComposerOutbox().discard(entry.localId);
      sentChips.delete(entry.localId);
      askComposer(draftKey, { kind: "focus" });
    },
    /** Hands an unsent message back to this chat's composer, then forgets it here; with no
     * composer shown to take it, the message stays where it is. */
    edit(entry: OutboxEntry) {
      const taken = askComposer(draftKey, {
        kind: "edit",
        body: entry.body,
        requestId: entry.requestId,
        asTask: entry.asTask,
        chips: sentChips.get(entry.localId) ?? [],
      });
      if (!taken) return;
      deviceComposerOutbox().discard(entry.localId);
      sentChips.delete(entry.localId);
    },
  };
}
