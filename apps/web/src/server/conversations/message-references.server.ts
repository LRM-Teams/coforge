import {
  resolveMentionTargets,
  type MentionSelectorInput,
  type MentionTarget,
  type ResolvedMention,
} from "@lrm/coforge-sdk/internal";
import type { Prisma } from "#src/generated/prisma/client";
import { readMessageReferences } from "#src/lib/message-references";

/**
 * The body a send stores, and the mentions it resolved: every reference the server can resolve
 * becomes its structured token, so no reader ever has to parse prose again. The body is read once
 * (`readMessageReferences`) and its candidates answered here:
 *
 * - `@handle` names one of the conversation's mention `targets` (a DM passes none, so its
 *   `@handle` stays text), with `bindings` — the CLI's `--mention` selectors — first;
 * - `task #N` names a task of this conversation;
 * - `#name` names a channel of this Workspace. Every channel is public and readable by every
 *   Workspace member (archived ones included), so any channel here is one the sender can see.
 *
 * Anything unresolved stays byte-for-byte as written, a token the sender typed included. A token is
 * a claim, never trusted as stored: every consumer checks it against authoritative data (a mention
 * token against the message's mention rows, a channel token against the Workspace's channels, a
 * task token against the conversation's tasks), so a typed token does nothing that typing the
 * text could not.
 */
export async function storeMessageBody(
  tx: Pick<Prisma.TransactionClient, "task" | "conversation">,
  scope: { workspaceId: string; conversationId: string },
  body: string,
  mentionScope: {
    targets: readonly MentionTarget[];
    bindings?: readonly MentionSelectorInput[];
  },
): Promise<{ body: string; mentions: ResolvedMention[] }> {
  const references = readMessageReferences(body);
  const { handles, taskNumbers, channelNames } = references.candidates;
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
  return {
    body: references.resolve({
      mention: mentions.target,
      task: (number) => knownTasks.has(number),
      channel: (name) => channelsByName.get(name),
    }),
    mentions: mentions.mentions,
  };
}
