import type { Prisma } from "#src/generated/prisma/client";

/**
 * Take the conversation's row lock for the rest of the transaction. Every writer that
 * allocates a message sequence or Task number, or changes membership, serializes here.
 */
export function lockConversation(tx: Prisma.TransactionClient, conversationId: string) {
  return tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
}

/** Every conversation row of a Workspace, locked the same way: the Workspace delete holds off each
 * writer above until its conversations are gone. */
export function lockWorkspaceConversations(tx: Prisma.TransactionClient, workspaceId: string) {
  return tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "workspaceId" = ${workspaceId}::uuid FOR UPDATE`;
}
