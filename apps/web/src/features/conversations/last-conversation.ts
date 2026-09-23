/**
 * Which conversation Chat opens when the URL names none: the channel, direct message, or Saved
 * view the user opened last in the Workspace (kept per device in `localStorage`, read only after
 * mount so SSR never depends on it) while it is still in their lists, else the first channel they
 * have joined.
 */

const STORAGE_PREFIX = "coforge-last-conversation:";

/** A conversation the Chat detail pane can show. */
export type ConversationTarget = { channelId: string } | { agentId: string } | { view: "saved" };

/** The route a conversation target opens, spreadable into `Link` or `navigate`. */
export function conversationRoute(target: ConversationTarget) {
  if ("channelId" in target) {
    return {
      to: "/messages/channels/$channelId",
      params: { channelId: target.channelId },
    } as const;
  }
  if ("agentId" in target) {
    return { to: "/messages/$agentId", params: { agentId: target.agentId } } as const;
  }
  return { to: "/messages/saved" } as const;
}

/** The conversation a de-localized pathname opens, if it is one. */
export function conversationAt(pathname: string): ConversationTarget | undefined {
  if (pathname === "/messages/saved") return { view: "saved" };
  const channel = /^\/messages\/channels\/([^/]+)$/.exec(pathname);
  if (channel) return { channelId: channel[1]! };
  const direct = /^\/messages\/([^/]+)$/.exec(pathname);
  if (direct) return { agentId: direct[1]! };
  return undefined;
}

/** Records `pathname` as the Workspace's last conversation when it is one; other pages leave the
 * memory as it was. Without storage (private window, blocked) Chat opens its default instead. */
export function rememberConversation(workspaceId: string, pathname: string): void {
  if (!conversationAt(pathname)) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + workspaceId, pathname);
  } catch {
    // Nothing remembered.
  }
}

/** The Workspace's last conversation on this device, if any. */
export function rememberedConversation(workspaceId: string): ConversationTarget | undefined {
  try {
    const pathname = localStorage.getItem(STORAGE_PREFIX + workspaceId);
    return pathname ? conversationAt(pathname) : undefined;
  } catch {
    return undefined;
  }
}

type ListedChannel = { id: string; joined: boolean; archived: boolean };

/** The first channel the viewer has joined, in sidebar order: the top of the CHANNELS group. */
export function firstJoinedChannel(channels: readonly ListedChannel[]): string | undefined {
  return channels.find((channel) => channel.joined && !channel.archived)?.id;
}

/**
 * Where Chat lands: the remembered conversation while it is still listed (an archived or deleted
 * channel, or a removed or closed direct message, is not), else the first joined channel.
 */
export function landingConversation(
  remembered: ConversationTarget | undefined,
  lists: { channels: readonly ListedChannel[]; agentIds: readonly string[] },
): ConversationTarget | undefined {
  if (remembered && "view" in remembered) return remembered;
  if (remembered && "channelId" in remembered) {
    const listed = lists.channels.some(
      (channel) => channel.id === remembered.channelId && !channel.archived,
    );
    if (listed) return remembered;
  }
  if (remembered && "agentId" in remembered && lists.agentIds.includes(remembered.agentId)) {
    return remembered;
  }
  const channelId = firstJoinedChannel(lists.channels);
  return channelId ? { channelId } : undefined;
}
