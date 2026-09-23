import type { PrismaClient } from "#src/generated/prisma/client";
import {
  messageReferenceCandidates,
  resolveMessageReferences,
  type MessageReferenceLookup,
} from "#src/lib/message-references";

type Transaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * The body a send stores: every reference the server can resolve becomes its structured token, so
 * no reader ever has to parse prose again. One tokenizer reads the body (see
 * `resolveMessageReferences`); this function answers its candidates from the database:
 *
 * - `task #N` names a task of this conversation;
 * - `#name` names a channel of this Workspace. Every channel is public and readable by every
 *   Workspace member (archived ones included), so any channel here is one the sender can see.
 *
 * Mentions are resolved by the caller, which knows the conversation's mention targets (a DM has
 * none), and passed in as `mention`. Anything unresolved stays byte-for-byte as written.
 */
export async function storedMessageBody(
  tx: Pick<Transaction, "task" | "conversation">,
  scope: { workspaceId: string; conversationId: string },
  body: string,
  mention?: MessageReferenceLookup["mention"],
): Promise<string> {
  const { taskNumbers, channelNames } = messageReferenceCandidates(body);
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
  return resolveMessageReferences(body, {
    mention,
    task: (number) => knownTasks.has(number),
    channel: (name) => channelsByName.get(name),
  });
}
