export const conversationRealtimeChannel = (conversationId: string) => `chat:${conversationId}`;

export type MessageAvailableEvent = {
  type: "message.available.v1";
  conversationId: string;
  messageId: string;
  sequence: number;
};

export function decodeMessageAvailableEvent(value: unknown): MessageAvailableEvent {
  if (value instanceof Uint8Array)
    return decodeMessageAvailableEvent(JSON.parse(new TextDecoder().decode(value)) as unknown);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const conversationId = Reflect.get(value, "conversationId");
  const messageId = Reflect.get(value, "messageId");
  const sequence = Reflect.get(value, "sequence");
  if (
    type !== "message.available.v1" ||
    typeof conversationId !== "string" ||
    !conversationId ||
    typeof messageId !== "string" ||
    !messageId ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  )
    throw new Error("invalid conversation event");
  return { type, conversationId, messageId, sequence };
}
