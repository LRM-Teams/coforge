import { createContext, useContext } from "react";

import type { SearchPreviewTarget } from "./search-preview";

/**
 * How the result rows reach the page's preview: the previewed target (to mark its row) and a way
 * to preview another. `preview` is undefined when there is no room beside the list, so rows open
 * their conversation instead.
 */
export const SearchPreviewContext = createContext<{
  previewed?: SearchPreviewTarget;
  preview?: (target: SearchPreviewTarget) => void;
}>({});

export function useSearchPreview() {
  return useContext(SearchPreviewContext);
}

/** Whether `target` is the one being previewed, message included. */
export function isPreviewed(
  previewed: SearchPreviewTarget | undefined,
  target: SearchPreviewTarget,
) {
  return (
    previewed?.kind === target.kind &&
    previewed.id === target.id &&
    previewed.messageId === target.messageId
  );
}

/** A preview's `open` search param: `channel:<id>` or `dm:<id>` (read by `searchPreviewTarget`). */
export function searchPreviewOpenParam(target: SearchPreviewTarget): string {
  return `${target.kind}:${target.id}`;
}

/** The preview the search URL names: `open` (`channel:<id>` or `dm:<id>`) at message `msg`. */
export function searchPreviewTarget(
  open: string | undefined,
  msg?: string,
): SearchPreviewTarget | undefined {
  const [kind, id] = open?.split(":") ?? [];
  return (kind === "channel" || kind === "dm") && id ? { kind, id, messageId: msg } : undefined;
}

/**
 * The preview for a message result: its channel or its direct conversation, at the row
 * the stream shows it on, with a thread reply's thread open at the reply (the stream stays at its
 * root), as Activity opens a thread.
 * Undefined when its place cannot be previewed.
 */
export function messagePreviewTarget(
  conversation: { id: string; channelName: string | null; directAgent: { id: string } | null },
  message: { id: string; threadRootId?: string },
): SearchPreviewTarget | undefined {
  const messageId = message.threadRootId ?? message.id;
  const thread = message.threadRootId
    ? { threadRootId: message.threadRootId, threadReplyId: message.id }
    : {};
  if (conversation.channelName)
    return { kind: "channel", id: conversation.id, messageId, ...thread };
  return conversation.directAgent
    ? { kind: "dm", id: conversation.id, messageId, ...thread }
    : undefined;
}
