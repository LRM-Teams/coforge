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

/**
 * The preview for a message result: its channel or its direct conversation's Agent, at the row
 * the stream shows it on (a thread reply's root). Undefined when its place cannot be previewed.
 */
export function messagePreviewTarget(
  conversation: { id: string; channelName: string | null; directAgent: { id: string } | null },
  message: { id: string; threadRootId?: string },
): SearchPreviewTarget | undefined {
  const messageId = message.threadRootId ?? message.id;
  if (conversation.channelName) return { kind: "channel", id: conversation.id, messageId };
  return conversation.directAgent
    ? { kind: "agent", id: conversation.directAgent.id, messageId }
    : undefined;
}
