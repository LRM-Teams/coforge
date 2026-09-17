export type MentionSelector = { type: "user" | "agent"; id: string; name: string };

const ACTOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The server's mention-handle grammar (`apps/web/src/server/conversations/mentions.ts`). */
const MENTION_HANDLE = /^[a-z0-9][a-z0-9_-]*$/;
const MENTION_HANDLE_MAX_LENGTH = 128;

/**
 * Parses one `--mention` value: `human:<actor-uuid>:<handle>` or `agent:<actor-uuid>:<handle>`.
 * `human` maps to type `"user"`. Returns `undefined` for any other shape.
 */
export function parseMentionSelector(value: string): MentionSelector | undefined {
  const parts = value.split(":");
  if (parts.length !== 3) return undefined;
  const [kind, id, handle] = parts;
  if (kind !== "human" && kind !== "agent") return undefined;
  if (!id || !ACTOR_UUID.test(id)) return undefined;
  if (!handle || handle.length > MENTION_HANDLE_MAX_LENGTH || !MENTION_HANDLE.test(handle))
    return undefined;
  return { type: kind === "human" ? "user" : "agent", id: id.toLowerCase(), name: handle };
}

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

/** Removes fenced and inline code spans so a mention inside a code sample is never counted. */
export function stripCodeSpans(body: string): string {
  return body.replace(FENCED_CODE, "").replace(INLINE_CODE, "");
}

/**
 * The set of `@handle` references present in `body` outside fenced/inline code. Mirrors the
 * mention regex in `apps/web/src/server/conversations/mentions.ts` (source of truth for the
 * server's mention grammar); duplicated here because this CLI package cannot import from
 * `apps/web`.
 */
const MENTION = /(?<![a-zA-Z0-9_@])@([a-z0-9][a-z0-9_-]*)(?![a-zA-Z0-9_-])/g;

export function mentionsInContent(body: string): Set<string> {
  const stripped = stripCodeSpans(body);
  return new Set([...stripped.matchAll(MENTION)].map((match) => match[1]!));
}
