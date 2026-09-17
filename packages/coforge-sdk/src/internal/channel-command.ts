/** Agent-facing channel lifecycle/roster command, shared by the CLI, the daemon's local proxy
 * and its dispatch to the cloud `agentApiRoutes.cloud.channels.*` routes. Travels as plain JSON
 * end to end, the same as `TaskCommand` and the message-operation local proxy payload. */
export const CHANNEL_OPERATIONS = [
  "info",
  "members",
  "join",
  "leave",
  "create",
  "update",
  "archive",
  "unarchive",
  "add-member",
  "remove-member",
] as const;
export type ChannelOperation = (typeof CHANNEL_OPERATIONS)[number];

export type ChannelCommand = {
  operation: ChannelOperation;
  requestId: string;
  /** `#name`, `#name:<thread>` (members only) or `@user` (members only); omitted for `create`. */
  target?: string;
  /** `create`/`update`: the new channel name, with or without a leading `#`. */
  name?: string;
  /** `create`/`update`: the new description. */
  description?: string;
  /** `add-member`/`remove-member`: exactly one of `user`/`agent` is set, as `@handle`. */
  user?: string;
  agent?: string;
};

export function isChannelOperation(value: unknown): value is ChannelOperation {
  return typeof value === "string" && (CHANNEL_OPERATIONS as readonly string[]).includes(value);
}
