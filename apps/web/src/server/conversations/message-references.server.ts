import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import {
  PG_INTEGER_MAX,
  resolveMentionTargets,
  type MentionSelectorInput,
  type MentionTarget,
  type ResolvedMention,
} from "@lrm/coforge-sdk/internal";
import type { Prisma } from "#src/generated/prisma/client";
import { readMessageReferences } from "#src/lib/message-references";
import {
  channelThreadRootsWhere,
  messageIdMatchesAnchor,
} from "#src/server/db/message-anchor.server";

/**
 * How many distinct thread references one body resolves, in reading order; any after them stay as
 * written. Mentions, tasks and channels each resolve in one query however many a body holds;
 * thread references read their channels' messages, so their number is bounded to keep that read
 * small inside the send transaction.
 */
export const MAX_THREAD_REFERENCES = 20;

/**
 * A channel's mention targets for `storeMessageBody`: only its active members the given handles
 * name (`user.username` or `agent.name`), so a send never reads the roster of #general, which
 * holds the whole Workspace. Handles resolve to ids through their unique indexes first, so the
 * member read is by id too, not a join tested against every member of the channel.
 */
export async function channelMentionTargets(
  tx: Pick<Prisma.TransactionClient, "conversationMember" | "user" | "agent">,
  scope: { workspaceId: string; conversationId: string },
  handles: readonly string[],
): Promise<MentionTarget[]> {
  const [users, agents] = await Promise.all([
    tx.user.findMany({
      where: { username: { in: [...handles] } },
      select: { id: true, username: true },
    }),
    tx.agent.findMany({
      where: { workspaceId: scope.workspaceId, name: { in: [...handles] } },
      select: { id: true, name: true },
    }),
  ]);
  if (!users.length && !agents.length) return [];
  const usernames = new Map(users.map((user) => [user.id, user.username]));
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const members = await tx.conversationMember.findMany({
    where: {
      conversationId: scope.conversationId,
      ...ACTIVE_MEMBER_WHERE,
      OR: [{ userId: { in: [...usernames.keys()] } }, { agentId: { in: [...agentNames.keys()] } }],
    },
    select: { id: true, userId: true, agentId: true },
  });
  return members.map((member) =>
    member.userId
      ? { key: member.id, type: "user", id: member.userId, handle: usernames.get(member.userId)! }
      : {
          key: member.id,
          type: "agent",
          id: member.agentId!,
          handle: agentNames.get(member.agentId!)!,
        },
  );
}

/**
 * The body a send stores, and the mentions it resolved: every reference the server can resolve
 * becomes its structured token, so no reader ever has to parse prose again. The body is read once
 * (`readMessageReferences`) and its candidates answered here:
 *
 * - `@handle` names one of the conversation's mention `targets` (a DM passes none, so its
 *   `@handle` stays text), with `bindings` — the CLI's `--mention` selectors — first. `targets`
 *   may instead load only the members the body's `@handle` candidates and the bindings' names
 *   name (`channelMentionTargets`), so a large channel's roster is never read to resolve a
 *   message that mentions a few members, or none;
 * - `task #N`, or a bare `#N`, names a task of this conversation;
 * - `#name` names a channel of this Workspace; a bare `#N` names one only when no task has that
 *   number (see `readMessageReferences` for the full precedence). Every channel is public and readable by every
 *   Workspace member (archived ones included), so any channel here is one the sender can see;
 * - `#name:shortid` names a top-level message of that channel, by a 6–8 hex prefix only that
 *   message's id has, or by its whole id (`channelThreadRootsWhere`, the rule an Agent's thread
 *   target is found by). Only the first `MAX_THREAD_REFERENCES` distinct ones are looked up, in one
 *   read per channel.
 *
 * Anything unresolved stays byte-for-byte as written, a token the sender typed included. A token is
 * a claim, never trusted as stored: every consumer checks it against authoritative data (a mention
 * token against the message's mention rows, a channel or thread token against the Workspace's
 * channels, a task token against the conversation's tasks), so a typed token does nothing that typing the
 * text could not.
 */
export async function storeMessageBody(
  tx: Pick<Prisma.TransactionClient, "task" | "conversation" | "message">,
  scope: { workspaceId: string; conversationId: string },
  body: string,
  mentionScope: {
    targets:
      | readonly MentionTarget[]
      | ((handles: readonly string[]) => Promise<readonly MentionTarget[]>);
    bindings?: readonly MentionSelectorInput[];
  },
): Promise<{ body: string; mentions: ResolvedMention[] }> {
  const references = readMessageReferences(body);
  const { handles } = references.candidates;
  const threads = references.candidates.threads.slice(0, MAX_THREAD_REFERENCES);
  // A thread reference's channel is looked up with the channels, in the same query.
  const channelNames = [
    ...new Set([...references.candidates.channelNames, ...threads.map((thread) => thread.name)]),
  ];
  // A `#N` above the largest task number names no task, and is never sent to the query, which
  // would reject it.
  const taskNumbers = references.candidates.taskNumbers.filter(
    (number) => number <= PG_INTEGER_MAX,
  );
  // A binding need not appear in the body, so the loader is asked for its name as well.
  const targetHandles = [
    ...new Set([...handles, ...(mentionScope.bindings ?? []).map((binding) => binding.name)]),
  ];
  const targets =
    typeof mentionScope.targets === "function"
      ? targetHandles.length
        ? await mentionScope.targets(targetHandles)
        : []
      : mentionScope.targets;
  const mentions = resolveMentionTargets(handles, targets, mentionScope.bindings);
  const knownTasks = new Set(
    taskNumbers.length
      ? (
          await tx.task.findMany({
            where: { conversationId: scope.conversationId, number: { in: taskNumbers } },
            select: { number: true },
          })
        ).map((task) => task.number)
      : [],
  );
  const channelsByName = new Map(
    channelNames.length
      ? (
          await tx.conversation.findMany({
            // A channel hidden from the Workspace names nothing: `#general` stays plain text.
            where: {
              workspaceId: scope.workspaceId,
              channelName: { in: channelNames },
              ...VISIBLE_CONVERSATION_WHERE,
            },
            select: { id: true, channelName: true },
          })
        ).map((channel) => [channel.channelName!, { id: channel.id, name: channel.channelName! }])
      : [],
  );
  // One read per channel over its top-level messages, for every anchor into it; an anchor two rows
  // answer is ambiguous, and names nothing.
  const anchorsByChannel = new Map<string, string[]>();
  for (const { name, anchor } of threads) {
    if (!channelsByName.has(name)) continue;
    anchorsByChannel.set(name, [...(anchorsByChannel.get(name) ?? []), anchor]);
  }
  const threadRoots = new Map<string, string>();
  for (const [name, anchors] of anchorsByChannel) {
    const rows = await tx.message.findMany({
      where: channelThreadRootsWhere(channelsByName.get(name)!.id, anchors),
      select: { id: true },
    });
    for (const anchor of anchors) {
      const matches = rows.filter((row) => messageIdMatchesAnchor(row.id, anchor));
      if (matches.length === 1) threadRoots.set(`${name}:${anchor}`, matches[0]!.id);
    }
  }
  return {
    body: references.resolve({
      mention: mentions.target,
      task: (number) => knownTasks.has(number),
      channel: (name) => channelsByName.get(name),
      thread: (name, anchor) => {
        const channel = channelsByName.get(name);
        const rootId = threadRoots.get(`${name}:${anchor}`);
        return channel && rootId
          ? { channelId: channel.id, rootId, name: channel.name }
          : undefined;
      },
    }),
    mentions: mentions.mentions,
  };
}
