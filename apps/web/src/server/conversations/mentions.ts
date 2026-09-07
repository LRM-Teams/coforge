const MENTION = /(?<![a-zA-Z0-9_@])@([a-z0-9][a-z0-9_-]*)(?![a-zA-Z0-9_-])/g;

export function mentionedNames(body: string) {
  return [...body.matchAll(MENTION)].map((match) => match[1]!);
}
