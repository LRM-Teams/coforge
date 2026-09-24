import { z } from "zod";

/**
 * Conversation thread selection as URL search state.
 *
 * `threadRootId` on the conversation routes is the source of truth for whether
 * the thread pane is open (TanStack Router: search params are application
 * state). `#message-<uuid>` is only a scroll target; it must not keep the pane
 * open after the user closes it. `task=<number>` likewise names the Task whose
 * popup (the Task and its thread) is open over the conversation's current tab.
 */

export function messageIdFromHash(hash: string): string | undefined {
  if (!hash.startsWith("#message-")) return;
  const messageId = hash.slice("#message-".length);
  return messageId || undefined;
}

export function threadRootFromMessageAnchor(
  messages: ReadonlyArray<{ id: string; threadRootId?: string }>,
  hash: string,
): string | undefined {
  const messageId = messageIdFromHash(hash);
  if (!messageId) return;
  const message = messages.find((candidate) => candidate.id === messageId);
  return message?.threadRootId ?? message?.id;
}

/** Prefer the search param; if it names a reply, resolve to that reply's root. */
export function resolveConversationThreadRoot(input: {
  searchThreadRootId: string | undefined;
  messages: ReadonlyArray<{ id: string; threadRootId?: string }>;
}): string | undefined {
  if (!input.searchThreadRootId) return;
  const message = input.messages.find((candidate) => candidate.id === input.searchThreadRootId);
  return message?.threadRootId ?? message?.id ?? input.searchThreadRootId;
}

/**
 * `T extends object`, not `T extends { threadRootId?: string }`: that constraint is a weak type
 * (every property optional), so search that does not already carry `threadRootId` has no property
 * in common with it and is rejected — while this function's whole job is adding the property to
 * search that lacks it. The return type says what it did, instead of claiming the input type back.
 */
export function conversationSearchWithThread<T extends object>(
  previous: T,
  threadRootId: string,
): T & { threadRootId: string } {
  return { ...previous, threadRootId };
}

export function conversationSearchWithoutThread<T extends { threadRootId?: string }>(
  previous: T,
): Omit<T, "threadRootId"> {
  const { threadRootId: _threadRootId, ...rest } = previous;
  return rest;
}

/** Validates the raw `task` search param: a Task number, or `undefined` (no popup) for anything
 * else, matching the routes' `.catch()` convention for `threadRootId`/`message`. */
export const openTaskParamSchema = z.coerce.number().int().positive().optional().catch(undefined);

export function conversationSearchWithTask<T extends object>(
  previous: T,
  task: number,
): T & { task: number } {
  return { ...previous, task };
}

export function conversationSearchWithoutTask<T extends { task?: unknown }>(
  previous: T,
): Omit<T, "task"> {
  const { task: _task, ...rest } = previous;
  return rest;
}

export function conversationSearchWithoutAgentProfile<
  T extends { profile?: string; agentTab?: unknown },
>(previous: T): Omit<T, "profile" | "agentTab"> {
  const { profile: _profile, agentTab: _agentTab, ...rest } = previous;
  return rest;
}

/** The pane's consume decision for `?message=<uuid>` — see `positionJumpDecision`. */
export type PositionJumpDecision =
  | { action: "idle" }
  | { action: "ignore" }
  | { action: "show"; id: string }
  | { action: "consume"; id: string };

/**
 * The pane's consume rules for `?message=<uuid>` — the Saved view's position-only jump (why a
 * param and never a hash: see `saved-messages-model`) — as a pure decision table. The pane
 * effect is a thin switch over this; apps/web's tests are renderToString-only (effects never
 * run, no DOM harness), so the rules are pinned here instead of an integration test:
 *
 * - first sight, no hash → `show`: load the window around the anchor and scroll
 *   (`ConversationPane.showMessage`);
 * - any hash present → `consume` only: the `#message-<id>` notification deep link owns the
 *   landing, two mechanisms never run together, but the param is still stripped;
 * - the same id already consumed → `ignore`: re-renders must not jump twice;
 * - param absent → `idle`: clear the marker, so leaving the conversation and re-clicking the
 *   same saved card jumps again.
 *
 * `consumed` is the pane's attempted-marker; `hash` is `window.location.hash`.
 */
export function positionJumpDecision(
  jumpMessage: string | undefined,
  hash: string,
  consumed: string | undefined,
): PositionJumpDecision {
  if (!jumpMessage) return { action: "idle" };
  if (consumed === jumpMessage) return { action: "ignore" };
  return hash ? { action: "consume", id: jumpMessage } : { action: "show", id: jumpMessage };
}
