/**
 * The one reader of a stored message body: every structured token reads back as the text a person
 * writes. Every plain-text consumer (an Agent-facing body, a copy, a list preview) goes through it,
 * so the order and the wording live in one place.
 */
import { replaceChannelReferenceTokens, replaceThreadReferenceTokens } from "./channel-references";
import { replaceMentionTokens } from "./mentions";
import { replaceTaskReferenceTokens } from "./task-references";

export type ReadableBodyNames = {
  /** The name a mention token reads as (without `@`); an unknown one leaves the token as written. */
  mention: (type: "user" | "agent", id: string) => string | undefined;
  /** A channel's current name, for channel and thread tokens; when absent or unknown, the name the
   * token stored. */
  channelName?: (id: string) => string | undefined;
};

/**
 * Reads a stored body back as text: `<@human|agent:uuid>` → `@name`, `<@task:68>` → `task #68`,
 * `<@channel:uuid:name>` → `#name`, `<@thread:uuid:uuid:name>` → `#name:<8 hex>`. A body with no
 * token is returned untouched.
 */
export function readableBody(body: string, names: ReadableBodyNames): string {
  if (!body.includes("<@")) return body;
  const mentions = replaceMentionTokens(body, (type, id) => {
    const name = names.mention(type, id);
    return name === undefined ? undefined : `@${name}`;
  });
  const tasks = replaceTaskReferenceTokens(mentions, (number) => `task #${number}`);
  const threads = replaceThreadReferenceTokens(tasks, names.channelName);
  return replaceChannelReferenceTokens(threads, names.channelName);
}
