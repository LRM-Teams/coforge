import {
  PG_INTEGER_MAX,
  resolveMentionTargets,
  type MentionSelectorInput,
  type MentionTarget,
  type ResolvedMention,
} from "@lrm/coforge-sdk/internal";
import type { Prisma } from "#src/generated/prisma/client";
import { readMessageReferences } from "#src/lib/message-references";
import { channelThreadRootWhere } from "#src/server/db/message-anchor.server";

/**
 * The body a send stores, and the mentions it resolved: every reference the server can resolve
 * becomes its structured token, so no reader ever has to parse prose again. The body is read once
 * (`readMessageReferences`) and its candidates answered here:
 *
 * - `@handle` names one of the conversation's mention `targets` (a DM passes none, so its
 *   `@handle` stays text), with `bindings` — the CLI's `--mention` selectors — first;
 * - `task #N`, or a bare `#N`, names a task of this conversation;
 * - `#name` names a channel of this Workspace; a bare `#N` names one only when no task has that
 *   number (see `readMessageReferences` for the full precedence). Every channel is public and readable by every
 *   Workspace member (archived ones included), so any channel here is one the sender can see;
 * - `#name:shortid` names a top-level message of that channel, by a 6–8 hex prefix only that
 *   message's id has, or by its whole id (`channelThreadRootWhere`, the rule an Agent's thread
 *   target is found by).
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
    targets: readonly MentionTarget[];
    bindings?: readonly MentionSelectorInput[];
  },
): Promise<{ body: string; mentions: ResolvedMention[] }> {
  const references = readMessageReferences(body);
  const { handles, threads } = references.candidates;
  // A thread reference's channel is looked up with the channels, in the same query.
  const channelNames = [
    ...new Set([...references.candidates.channelNames, ...threads.map((thread) => thread.name)]),
  ];
  // A `#N` above the largest task number names no task, and is never sent to the query, which
  // would reject it.
  const taskNumbers = references.candidates.taskNumbers.filter(
    (number) => number <= PG_INTEGER_MAX,
  );
  const mentions = resolveMentionTargets(handles, mentionScope.targets, mentionScope.bindings);
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
            where: { workspaceId: scope.workspaceId, channelName: { in: channelNames } },
            select: { id: true, channelName: true },
          })
        ).map((channel) => [channel.channelName!, { id: channel.id, name: channel.channelName! }])
      : [],
  );
  // Each thread reference is its own range read over the channel's top-level messages; two rows
  // mean the prefix is ambiguous, and it names nothing.
  const threadRoots = new Map<string, string>();
  for (const { name, anchor } of threads) {
    const channel = channelsByName.get(name);
    if (!channel) continue;
    const roots = await tx.message.findMany({
      where: channelThreadRootWhere(channel.id, anchor),
      take: 2,
      select: { id: true },
    });
    if (roots.length === 1) threadRoots.set(`${name}:${anchor}`, roots[0]!.id);
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
