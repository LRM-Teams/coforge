/**
 * One rule for the name the browser shows as a message's sender, shared by the three browser
 * message projections (`public-channels.server.ts`, `conversation-history.server.ts`,
 * `direct-conversation.repositories.server.ts`) so they cannot drift apart again — before this
 * they had three different rules, and a person showed as `@username` next to an Agent showing
 * its display name.
 *
 * The browser shows the display name, like Slack: `@handle` is what you type, copy and see on a
 * profile, not the identity on every message row. The Agent-facing projection
 * (`MESSAGE_SENDER_SELECT` / `toAgentMessage`) deliberately keeps `@handle`, because an Agent
 * replies and mentions by handle.
 */
type BrowserSender =
  | {
      user?: { username: string; displayName?: string | null } | null;
      agent?: { name: string; displayName?: string | null } | null;
    }
  | null
  | undefined;

export function browserSenderName(sender: BrowserSender): string {
  // A null sender is the server identity; see TaskBoard's server-authored messages.
  if (!sender) return "System";
  if (sender.user) return sender.user.displayName?.trim() || sender.user.username;
  if (sender.agent) return sender.agent.displayName?.trim() || sender.agent.name;
  return "System";
}

/**
 * The sender's handle, kept beside the display name because a display name is not an identity:
 * the composer ranks mention candidates by who recently spoke here, and that has to match on the
 * handle `Mentionable` carries (`mention-text.ts`). Deriving it by stripping an "@" off the
 * displayed name is what broke when the browser stopped being attributed by handle.
 * `undefined` for a server-authored message, which nobody can mention.
 */
export function browserSenderHandle(sender: BrowserSender): string | undefined {
  if (!sender) return undefined;
  if (sender.user) return sender.user.username;
  if (sender.agent) return sender.agent.name;
  return undefined;
}
