/**
 * The single definition of CoForge's structured-mention grammar and content-presence check,
 * shared by the CLI (parsing `--mention`), the daemon (`agent-proxy.ts`'s payload validation and
 * `runtime.ts`'s `#sendAgentMessage` presence check), and Web/backend (the send route's shape
 * validation, and `apps/web/src/server/conversations/mentions.ts`'s plain-text mention scan,
 * which imports `MENTION_PATTERN` from here rather than keeping its own copy).
 */

export type MentionSelectorInput = { type: "user" | "agent"; id: string; name: string };

const ACTOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The server's mention-handle grammar. */
export const MENTION_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const MENTION_HANDLE_MAX_LENGTH = 128;
export const MENTION_SELECTORS_MAX_LENGTH = 32;

/**
 * Parses one `--mention` value: `human:<actor-uuid>:<handle>` or `agent:<actor-uuid>:<handle>`.
 * `human` maps to type `"user"`. Returns `undefined` for any other shape.
 */
export function parseMentionSelector(value: string): MentionSelectorInput | undefined {
  const parts = value.split(":");
  if (parts.length !== 3) return undefined;
  const [kind, id, handle] = parts;
  if (kind !== "human" && kind !== "agent") return undefined;
  if (!id || !ACTOR_UUID.test(id)) return undefined;
  if (!handle || handle.length > MENTION_HANDLE_MAX_LENGTH || !MENTION_HANDLE_PATTERN.test(handle))
    return undefined;
  return { type: kind === "human" ? "user" : "agent", id: id.toLowerCase(), name: handle };
}

/**
 * Shape-only validation for a wire-level mention array (used by the daemon-local proxy and the
 * Web send route): array bounds, `type`, `id` as a UUID, and `name` matching the handle grammar.
 * Binding semantics (does `id`/`name` match a real conversation member) are enforced by the
 * repository, not here.
 */
export function isValidMentionSelectorArray(
  value: unknown,
  maxLength = MENTION_SELECTORS_MAX_LENGTH,
): value is MentionSelectorInput[] {
  if (!Array.isArray(value) || value.length > maxLength) return false;
  return value.every((mention) => {
    if (!mention || typeof mention !== "object") return false;
    const candidate = mention as Record<string, unknown>;
    return (
      (candidate.type === "user" || candidate.type === "agent") &&
      typeof candidate.id === "string" &&
      ACTOR_UUID.test(candidate.id) &&
      typeof candidate.name === "string" &&
      candidate.name.length <= MENTION_HANDLE_MAX_LENGTH &&
      MENTION_HANDLE_PATTERN.test(candidate.name)
    );
  });
}

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

/** Removes fenced and inline code spans so a mention inside a code sample is never counted. */
export function stripCodeSpans(body: string): string {
  return body.replace(FENCED_CODE, "").replace(INLINE_CODE, "");
}

/** The single definition of the server's plain-text `@handle` mention pattern. */
export const MENTION_PATTERN = /(?<![a-zA-Z0-9_@])@([a-z0-9][a-z0-9_-]*)(?![a-zA-Z0-9_-])/g;

/** The set of `@handle` references present in `body` outside fenced/inline code. */
export function mentionsInContent(body: string): Set<string> {
  const stripped = stripCodeSpans(body);
  return new Set([...stripped.matchAll(MENTION_PATTERN)].map((match) => match[1]!));
}

/**
 * Embedded mention tokens — the stored-body form of a resolved mention, in the spirit of
 * Slack's `<@U123>`: the actor UUID (not the display handle) is the stable anchor, so a later
 * rename never orphans history. `human` names a Workspace User, `agent` an Agent; the words
 * match the `--mention human:<uuid>:<handle>` selector kinds. Plain `@handle` text remains
 * valid input at every send edge; only resolved mentions are rewritten to this form at
 * persistence time, and every Agent-facing read path translates tokens back to `@handle`.
 */
export const MENTION_TOKEN_PATTERN =
  /<@(human|agent):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/** The stored-body token for one resolved mention: `<@human:uuid>` or `<@agent:uuid>`. */
export function mentionToken(type: "user" | "agent", id: string): string {
  return `<@${type === "user" ? "human" : "agent"}:${id.toLowerCase()}>`;
}

/**
 * Rewrites every embedded mention token through `resolve` (typically to its `@handle` for an
 * Agent-facing payload). A token `resolve` does not know is left byte-for-byte intact, so a
 * caller that lacks the mention rows degrades to showing the raw token rather than dropping
 * information.
 */
export function replaceMentionTokens(
  body: string,
  resolve: (type: "user" | "agent", id: string) => string | undefined,
): string {
  return body.replace(
    MENTION_TOKEN_PATTERN,
    (token, kind: string, id: string) =>
      resolve(kind === "human" ? "user" : "agent", id.toLowerCase()) ?? token,
  );
}

export type BodySegment = { text: string; code: boolean };

/**
 * Splits a body into code and non-code segments without dropping a byte
 * (`segments.map((s) => s.text).join("") === body`), using exactly `stripCodeSpans`' two-pass
 * semantics: fenced blocks first, then inline code within the remaining text. Mention grammar
 * never applies inside code, and writers need the code text preserved.
 */
export function splitCodeSpans(body: string): BodySegment[] {
  const fenced = new RegExp(FENCED_CODE.source, "g");
  const inline = new RegExp(INLINE_CODE.source, "g");
  const segments: BodySegment[] = [];
  let offset = 0;
  const pushText = (text: string) => {
    let textOffset = 0;
    for (const match of text.matchAll(inline)) {
      if (match.index > textOffset)
        segments.push({ text: text.slice(textOffset, match.index), code: false });
      segments.push({ text: match[0], code: true });
      textOffset = match.index + match[0].length;
    }
    if (textOffset < text.length) segments.push({ text: text.slice(textOffset), code: false });
  };
  for (const match of body.matchAll(fenced)) {
    pushText(body.slice(offset, match.index));
    segments.push({ text: match[0], code: true });
    offset = match.index + match[0].length;
  }
  pushText(body.slice(offset));
  return segments;
}

/** A conversation member a mention can resolve to, in the server's member-directory shape. */
export type MentionTarget = {
  /** The caller's stable dedupe key for the member (the conversation-member id). */
  key: string;
  type: "user" | "agent";
  /** The actor UUID embedded in the stored token. */
  id: string;
  handle: string;
};

export type ResolvedMention = MentionTarget;

/**
 * Resolves the `@handle`s a body being persisted names (the Web recognizer's candidate handles,
 * in first-appearance order) against the conversation's mention targets. The body itself is
 * rewritten by that recognizer, with `target` as its mention lookup.
 *
 * - Resolution merges structured `bindings` (the CLI's `--mention` selectors; unmatched ones
 *   are ignored — member validation is the repository's job) with the plain `@handle` text
 *   matches.
 * - A handle shared by a User and an Agent member is ambiguous; the Agent wins, because an
 *   Agent mention is what steers delivery, and the binding form stays available to disambiguate.
 * - `target` answers every resolved handle with the member its occurrences are rewritten to;
 *   an unresolved `@handle` stays as written.
 * - `mentions` is deduped by member key; order is bindings first, then first text appearance.
 */
export function resolveMentionTargets(
  handles: readonly string[],
  targets: readonly MentionTarget[],
  bindings: readonly MentionSelectorInput[] = [],
): { mentions: ResolvedMention[]; target: (handle: string) => MentionTarget | undefined } {
  const byKey = new Map<string, ResolvedMention>();
  for (const binding of bindings) {
    const match = targets.find(
      (target) =>
        target.type === binding.type &&
        target.id.toLowerCase() === binding.id.toLowerCase() &&
        target.handle === binding.name,
    );
    if (match) byKey.set(match.key, match);
  }
  const agentByHandle = new Map<string, MentionTarget>();
  const userByHandle = new Map<string, MentionTarget>();
  for (const target of targets) {
    const map = target.type === "agent" ? agentByHandle : userByHandle;
    if (!map.has(target.handle)) map.set(target.handle, target);
  }
  for (const handle of handles) {
    const target = agentByHandle.get(handle) ?? userByHandle.get(handle);
    if (target && !byKey.has(target.key)) byKey.set(target.key, target);
  }
  const targetByHandle = new Map<string, MentionTarget>();
  for (const mention of byKey.values()) targetByHandle.set(mention.handle, mention);
  return { mentions: [...byKey.values()], target: (handle) => targetByHandle.get(handle) };
}
