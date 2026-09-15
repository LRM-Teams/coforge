import type { Prisma } from "../../../generated/client";

/**
 * Take the conversation's row lock for the rest of the transaction. Every writer that
 * allocates a message sequence or Task number, or changes membership, serializes here.
 */
export function lockConversation(tx: Prisma.TransactionClient, conversationId: string) {
  return tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
}
