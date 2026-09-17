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
