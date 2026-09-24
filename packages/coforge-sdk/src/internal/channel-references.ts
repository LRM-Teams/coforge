/**
 * Structured channel references — the stored-body form of a `#name` that names a channel, and of a
 * `#name:shortid` that names one of its threads, in the same `<@kind:…>` family as the mention token
 * (`<@human:uuid>`, see `mentions.ts`) and the task token (`<@task:68>`, see `task-references.ts`).
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
 * A thread reference, `#name:` followed by a short (6–8 hex) or full message id, in any case:
 * group 1 is the channel name as written, group 2 the id. It is a different reference than the
 * channel it names, so it is read whole, before a `#name` could be. It names a thread only when the
 * channel exists and the id is one of that channel's top-level messages, unambiguously.
 */
export const THREAD_REFERENCE_PATTERN = new RegExp(
  `#([\\p{L}\\p{N}_-]+):(${UUID}|[0-9a-f]{6,8})(?![0-9a-z-])`,
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

/**
 * The stored-body token for one resolved thread reference:
 * `<@thread:<channel uuid>:<root message uuid>:<name>>`. The ids are the stable anchors a renderer
 * opens the thread by; the name is the channel's name when the message was sent, as in the channel
 * token. The short id a writer typed is not kept: every reader derives it from the root id (its
 * first eight hex characters), the one form a thread target takes.
 */
export const THREAD_REFERENCE_TOKEN_PATTERN = new RegExp(
  `<@thread:(${UUID}):(${UUID}):([a-z0-9][a-z0-9_-]*)>`,
  "gi",
);

/** The stored-body token for one thread, by its channel's id, its root message's id and the
 * channel's name at send time. */
export function threadReferenceToken(channelId: string, rootId: string, name: string): string {
  return `<@thread:${channelId.toLowerCase()}:${rootId.toLowerCase()}:${name}>`;
}

/** How a thread reference reads as text: `#name:` and the root message's first eight hex
 * characters — the same `#name:<8 hex>` an Agent writes to target that thread. */
export function threadReferenceText(name: string, rootId: string): string {
  return `#${name}:${rootId.slice(0, 8).toLowerCase()}`;
}

/**
 * Rewrites every thread-reference token to `#name:<8 hex>`: the channel's current name when
 * `currentName` knows the id, otherwise the name stored in the token. Like a channel token, a
 * thread token always has a readable form, so it is never left raw.
 */
export function replaceThreadReferenceTokens(
  body: string,
  currentName?: (channelId: string) => string | undefined,
): string {
  return body.replace(
    THREAD_REFERENCE_TOKEN_PATTERN,
    (_token, channelId: string, rootId: string, name: string) =>
      threadReferenceText(currentName?.(channelId.toLowerCase()) ?? name, rootId),
  );
}
