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

/** The member on the other side of a DM between people, from the viewer's seat (the viewer in their
 * conversation with themself); `undefined` for any other key. */
export function peopleDirectPeerId(directKey: string | null, viewerId: string) {
  if (!directKey || !isPeopleDirectKey(directKey)) return undefined;
  const [first, second] = peopleDirectKeyPair(directKey);
  return first === viewerId ? second : first;
}

/** The key of a member's direct conversation with an Agent (`agent:` sorts before `user:`). */
export function agentDirectKey(userId: string, agentId: string) {
  return `agent:${agentId}|user:${userId}`;
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
