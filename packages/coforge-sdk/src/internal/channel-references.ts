/**
 * Structured channel references — the stored-body form of a `#name` that names a channel, in the
 * same `<@kind:…>` family as the mention token (`<@human:uuid>`, see `mentions.ts`) and the task
 * token (`<@task:68>`, see `task-references.ts`).
 *
 * The server resolves a `#name` at send time (the Web message-reference recognizer) and stores
 * `<@channel:<uuid>:<name>>`: the id is the stable anchor a renderer links by, and the name is the
 * channel's name when the message was sent, so every plain-text reader can print `#name` without a
 * lookup and a channel it cannot resolve still reads sensibly. The separator is `:` rather than
 * Slack's `|` because an unescaped `|` splits a GFM table cell, and a channel name
 * (`[a-z0-9][a-z0-9_-]*`) never contains `:`.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The prose form of a channel reference: `#` and a run of letters in any script, digits, `_` and
 * `-`, taken whole — so `#product-launch` is never `#product` followed by `-launch`, and
 * `#product频道` is the name `product频道`. There is no left boundary (`去#random 频道` is a
 * reference). A run is a reference only when it names a channel, and only in prose: the
 * recognizer (`apps/web/src/lib/message-references.ts`) never reads code, links or HTML.
 */
export const CHANNEL_REFERENCE_PATTERN = /#([\p{L}\p{N}_-]+)/gu;

/**
 * A thread reference, `#name:` followed by a short (6–8 hex) or full message id. It is a different
 * reference than the channel it names; until thread references are tokenized it is kept as text,
 * whole.
 */
export const THREAD_REFERENCE_PATTERN = new RegExp(
  `#[\\p{L}\\p{N}_-]+:(?:${UUID}|[0-9a-f]{6,8})(?![0-9a-z-])`,
  "giu",
);

/**
 * CoForge's channel-name grammar: what a channel can be called. A `#name` outside it can never name
 * a channel.
 */
export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The stored-body token for one resolved channel reference: `<@channel:<uuid>:<name>>`. */
export const CHANNEL_REFERENCE_TOKEN_PATTERN = new RegExp(
  `<@channel:(${UUID}):([a-z0-9][a-z0-9_-]*)>`,
  "gi",
);

/** The stored-body token for one channel, by its id and its name at send time. */
export function channelReferenceToken(id: string, name: string): string {
  return `<@channel:${id.toLowerCase()}:${name}>`;
}

/**
 * Rewrites every channel-reference token to `#name`: the channel's current name when
 * `currentName` knows the id, otherwise the name stored in the token. Unlike a mention token, a
 * channel token always has a readable form, so it is never left raw.
 */
export function replaceChannelReferenceTokens(
  body: string,
  currentName?: (id: string) => string | undefined,
): string {
  return body.replace(
    CHANNEL_REFERENCE_TOKEN_PATTERN,
    (_token, id: string, name: string) => `#${currentName?.(id.toLowerCase()) ?? name}`,
  );
}
