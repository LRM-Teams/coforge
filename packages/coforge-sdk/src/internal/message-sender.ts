import { codePointLength } from "./truncate";
import { MENTION_HANDLE_PATTERN } from "./mentions";

/**
 * A message's sender is a kind, a handle and a description — not one fused string.
 * `MessageSenderKind` follows the `activityKind` convention
 * (`packages/coforge-sdk/src/internal/agent-display.ts`): a proto `string`, a closed TS union, and
 * a `Set` guard, with no proto enum — this repository's protobuf schemas define none.
 */
export type MessageSenderKind = "human" | "agent" | "system";

const MESSAGE_SENDER_KINDS = new Set<MessageSenderKind>(["human", "agent", "system"]);

export function isMessageSenderKind(value: unknown): value is MessageSenderKind {
  return typeof value === "string" && MESSAGE_SENDER_KINDS.has(value as MessageSenderKind);
}

/**
 * The longest public handle a sender can have. An Agent's name is the longer of the two identities
 * that reach this field (`AGENT_NAME_MAX_LENGTH`, `apps/web/src/features/agents/agent.schemas.ts`);
 * a human's username is bounded well below it by the username grammar in
 * `apps/web/src/server/auth/user-identity.repository.server.ts`. The bound is restated here rather
 * than imported because this package must not depend on the Web app; a change to either identity
 * schema has to be reflected here in the same change.
 */
const SENDER_HANDLE_MAX_LENGTH = 60;

/**
 * An internal id is never a public handle. Hex and hyphens are ordinary handle characters, so a
 * raw actor id satisfies the handle character class on its own; the rule that keeps one from
 * reaching an Agent as a sender has to name the id shape rather than rely on a length bound to
 * exclude it by accident.
 */
const ACTOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The public handle grammar, reusing the one definition of CoForge's handle character class
 * (`MENTION_HANDLE_PATTERN`, `./mentions`) so a sender handle and a mention handle cannot drift
 * into two different ideas of what a handle looks like. The length bound and the internal-id
 * exclusion are this field's own.
 */
export function isPrintableSenderHandle(value: string): boolean {
  return (
    MENTION_HANDLE_PATTERN.test(value) &&
    codePointLength(value) <= SENDER_HANDLE_MAX_LENGTH &&
    !ACTOR_ID.test(value)
  );
}

/**
 * The one boundary rule for a `(kind, handle)` pair: `kind` must be a
 * known value, `human`/`agent` require a handle matching the public handle grammar, and `system`
 * requires an empty handle. Used at every wire boundary that carries a sender or latest-sender
 * pair, so a malformed pair is rejected the same way everywhere instead of reaching a render.
 */
export function isValidMessageSender(kind: unknown, handle: unknown): kind is MessageSenderKind {
  if (!isMessageSenderKind(kind) || typeof handle !== "string") return false;
  if (kind === "system") return handle === "";
  return isPrintableSenderHandle(handle);
}

/** Throws a named error unless `(kind, handle)` is a valid sender pair; `context` names the wire
 * shape being decoded so one rule can report which boundary rejected it. An assertion function
 * (like `isValidMessageSender`'s own type guard) so a caller that narrowed `kind` through the old
 * `if (!isValidMessageSender(...)) throw` idiom keeps that same narrowing after switching to this
 * shared helper. */
export function assertValidMessageSender(
  kind: unknown,
  handle: unknown,
  context: string,
): asserts kind is MessageSenderKind {
  if (!isValidMessageSender(kind, handle)) throw new Error(`invalid ${context} sender`);
}

/**
 * Renders a sender exactly as the Agent-visible message line shows it:
 * `system` for a system message, `@handle — description` when a description exists, `@handle`
 * alone otherwise.
 */
export function renderMessageSender(
  kind: MessageSenderKind,
  handle: string,
  description?: string,
): string {
  if (kind === "system") return "system";
  return description ? `@${handle} — ${description}` : `@${handle}`;
}
