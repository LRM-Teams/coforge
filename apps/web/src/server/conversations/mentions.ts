import { MENTION_PATTERN } from "@lrm/coforge-sdk/internal";

export function mentionedNames(body: string) {
  return [...body.matchAll(MENTION_PATTERN)].map((match) => match[1]!);
}
