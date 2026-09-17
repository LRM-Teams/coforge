import { MENTION_PATTERN, replaceMentionTokens } from "@lrm/coforge-sdk/internal";

export function mentionedNames(body: string) {
  return [...body.matchAll(MENTION_PATTERN)].map((match) => match[1]!);
}

/** The mention-row projection every body reader needs to resolve embedded tokens. */
export type MessageMentionRef = { kind: string; actorId: string; handle: string };

/**
 * The Agent-facing body: embedded mention tokens (`<@human:uuid>`/`<@agent:uuid>`) read back as
 * plain `@handle` text. The token form is a storage/browser-render concern and never crosses
 * onto the Agent channel; an unresolved token (no matching mention row) stays as written.
 */
export function agentReadableBody(body: string, mentions: readonly MessageMentionRef[]): string {
  return replaceMentionTokens(body, (type, id) => {
    const mention = mentions.find((row) => row.kind === type && row.actorId.toLowerCase() === id);
    return mention ? `@${mention.handle}` : undefined;
  });
}
