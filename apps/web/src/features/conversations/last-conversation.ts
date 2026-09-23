/**
 * The conversation Chat reopens: the channel, direct message, or Saved view the user opened last
 * in a Workspace. Kept per device in `localStorage` (read only after mount, like
 * `directory-sections.ts`, so SSR never depends on it) and checked against the current
 * conversation list, so a deleted channel or a removed Agent is never reopened.
 */

const STORAGE_PREFIX = "coforge-last-conversation:";

export type RememberedConversation =
  | { channelId: string }
  | { agentId: string }
  | { view: "saved" };

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The conversation a de-localized pathname opens, if it is one. */
function conversationAt(pathname: string): RememberedConversation | undefined {
  if (pathname === "/messages/saved") return { view: "saved" };
  const channel = /^\/messages\/channels\/([^/]+)$/.exec(pathname);
  if (channel) return { channelId: channel[1]! };
  const direct = /^\/messages\/([^/]+)$/.exec(pathname);
  if (direct) return { agentId: direct[1]! };
  return undefined;
}

/** Records `pathname` as the Workspace's last conversation when it is one; other pages leave the
 * memory as it was. */
export function rememberConversation(workspaceId: string, pathname: string): void {
  const conversation = conversationAt(pathname);
  if (!conversation) return;
  try {
    storage()?.setItem(STORAGE_PREFIX + workspaceId, JSON.stringify(conversation));
  } catch {
    // Storage full or blocked: Chat then opens its default conversation.
  }
}

/** The Workspace's last conversation, if it is still in the viewer's lists. */
export function rememberedConversation(
  workspaceId: string,
  available: { channelIds: readonly string[]; agentIds: readonly string[] },
): RememberedConversation | undefined {
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(STORAGE_PREFIX + workspaceId);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  if ("view" in value && value.view === "saved") return { view: "saved" };
  if ("channelId" in value && typeof value.channelId === "string") {
    return available.channelIds.includes(value.channelId)
      ? { channelId: value.channelId }
      : undefined;
  }
  if ("agentId" in value && typeof value.agentId === "string") {
    return available.agentIds.includes(value.agentId) ? { agentId: value.agentId } : undefined;
  }
  return undefined;
}
