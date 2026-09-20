import { isValidMessageSender, type MessageSenderKind } from "@lrm/coforge-sdk/internal";
import type { Prisma } from "../../../generated/client";

/**
 * One rule for the name the browser shows as a message's sender, shared by the three browser
 * message projections (`public-channels.server.ts`, `conversation-history.server.ts`,
 * `direct-conversation.repositories.server.ts`) so they cannot drift apart again — before this
 * they had three different rules, and a person showed as `@username` next to an Agent showing
 * its display name.
 *
 * The browser shows the display name, like Slack: `@handle` is what you type, copy and see on a
 * profile, not the identity on every message row. The Agent-facing projection
 * (`agentMessageSender`, below) deliberately keeps `@handle`, because an Agent replies and
 * mentions by handle.
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

/** A sender relation could not be resolved to a public identity: no substitute is ever shipped
 * to an Agent in its place (ADR 0052, decision B) — never `"agent"`, an internal id, or an empty
 * handle. Named so a caller can distinguish this from an authorization or not-found error. */
export class UnresolvedMessageSenderError extends Error {
  constructor(reason: string) {
    super(`Agent message sender could not be resolved: ${reason}`);
    this.name = "UnresolvedMessageSenderError";
  }
}

export type AgentMessageSender = {
  kind: MessageSenderKind;
  /** Public handle without a leading "@"; empty for `system`. */
  handle: string;
  /** The sender's role text; empty when there is none. */
  description: string;
};

type AgentMessageSenderRelation =
  | {
      agentId: string | null;
      agent?: { name: string; description: string } | null;
      user?: { username: string; description: string } | null;
    }
  | null
  | undefined;

/** Just enough of the sender to project its Agent-facing kind, handle and description
 * (`agentMessageSender`, below): shared by every Prisma read that feeds it, so the shape cannot
 * drift into three different field sets across the channel, direct-conversation and Task
 * message paths. */
export const MESSAGE_SENDER_SELECT = {
  select: {
    agentId: true,
    agent: { select: { name: true, description: true } },
    user: { select: { username: true, description: true } },
  },
} satisfies NonNullable<Prisma.MessageInclude["sender"]>;

/**
 * The one exported projection from a sender relation to the three Agent-visible facts (ADR 0052,
 * decision B): `sender_kind`, `sender_handle`, `sender_description`. A `null`/`undefined` sender
 * is the server identity (`kind: "system"`, no handle, no description) — see TaskBoard's
 * server-authored messages. A non-null sender with no resolvable handle throws
 * `UnresolvedMessageSenderError` rather than substituting `"agent"`, an internal id, or an empty
 * string; every Agent-facing composition site (direct messages, channel deliveries, recovery,
 * and Task delivery) calls this instead of hand-building its own rule.
 */
export function agentMessageSender(sender: AgentMessageSenderRelation): AgentMessageSender {
  if (!sender) return { kind: "system", handle: "", description: "" };
  if (sender.agentId) {
    const handle = sender.agent?.name;
    if (!handle) throw new UnresolvedMessageSenderError("Agent sender has no resolvable name");
    return wellFormed({ kind: "agent", handle, description: sender.agent?.description ?? "" });
  }
  const handle = sender.user?.username;
  if (!handle) throw new UnresolvedMessageSenderError("human sender has no resolvable username");
  return wellFormed({ kind: "human", handle, description: sender.user?.description ?? "" });
}

/**
 * Resolving a name is not the same as resolving an identity: a stored name predating today's
 * grammar, or one that is really an internal id, would otherwise travel on to an Agent looking
 * like a handle it can reply to. This projection promises a handle an Agent can actually use, so
 * the grammar is checked here rather than by each caller.
 */
function wellFormed(sender: AgentMessageSender): AgentMessageSender {
  if (!isValidMessageSender(sender.kind, sender.handle))
    throw new UnresolvedMessageSenderError(`${sender.kind} sender is not a public @username`);
  return sender;
}
