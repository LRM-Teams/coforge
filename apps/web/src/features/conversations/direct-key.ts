/**
 * A direct conversation's `directKey`: its participants' `<kind>:<id>` parts in lexical order,
 * joined by `|` (`docs/database-schema/conversations.md`). Between people both parts are
 * `user:`, and a member's conversation with themself repeats their own part.
 */
export function peopleDirectKey(userId: string, otherUserId: string) {
  return [userId, otherUserId]
    .sort()
    .map((id) => `user:${id}`)
    .join("|");
}

/** Whether a direct conversation is between people (no Agent part). */
export function isPeopleDirectKey(directKey: string) {
  return directKey.split("|").every((part) => part.startsWith("user:"));
}

/** The two people a key between people names, in key order (the same one twice for a member's
 * conversation with themself). */
export function peopleDirectKeyPair(directKey: string): [string, string] {
  const [first, second] = directKey.split("|").map((part) => part.slice("user:".length));
  return [first!, second ?? first!];
}
