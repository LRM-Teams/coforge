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

/** Messages sent (or retried) from this page. Only their failure is announced to screen readers:
 * a failure restored from an earlier page was announced then, and must not be re-read on every
 * return to the chat. */
const sentFromThisPage = new Set<string>();

export function wasSentFromThisPage(localId: string) {
  return sentFromThisPage.has(localId);
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

function askComposer(draftKey: string, request: ComposerRequest) {
  for (const listener of composerListeners.get(draftKey) ?? []) listener(request);
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
    if (
      !deviceComposerOutbox()
        .entries(draftKey)
        .some((entry) => entry.localId === localId)
    )
      sentChips.delete(localId);
  }

  return {
    send(message: OutgoingMessage, chips: PendingAttachment[]) {
      if (chips.length > 0) sentChips.set(message.localId, chips);
      sentFromThisPage.add(message.localId);
      void settle(message.localId, deviceComposerOutbox().send(message, deliver));
    },
    retry(entry: OutboxEntry) {
      sentFromThisPage.add(entry.localId);
      askComposer(draftKey, { kind: "focus" });
      // The same request id, so a send the server did accept is not posted twice.
      void settle(entry.localId, deviceComposerOutbox().retry(entry.localId, deliver));
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
    /** Hands an unsent message back to this chat's composer, then forgets it here. */
    edit(entry: OutboxEntry) {
      const chips = sentChips.get(entry.localId) ?? [];
      deviceComposerOutbox().discard(entry.localId);
      sentChips.delete(entry.localId);
      askComposer(draftKey, {
        kind: "edit",
        body: entry.body,
        requestId: entry.requestId,
        asTask: entry.asTask,
        chips,
      });
    },
  };
}
