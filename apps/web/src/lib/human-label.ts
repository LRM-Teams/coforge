/**
 * The names a person can be called by. `fullName` is required (a `null` when there is none) so a
 * query that builds a label from a User row cannot forget to select it: the type check finds it.
 */
export type HumanNames = {
  displayName?: string | null;
  fullName: string | null;
  username: string;
};

/**
 * The one name every surface shows for a person: their display name, else their full name, else
 * their username. The username fallback serves only a person who has not been asked for a name
 * yet; it is what `@handle` looks like, not who they are.
 *
 * Pass the row (`humanLabel(row.user)`) rather than picking fields, so a caller changes only
 * when the rule gains a name. An Agent has its own rule (`displayName || name`); this is not it.
 */
export function humanLabel(names: HumanNames): string {
  return names.displayName?.trim() || names.fullName?.trim() || names.username;
}

// Base sensitivity: "Alex" and "alex" are one name to a reader, so the username settles the tie.
const labelCollator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Orders people by the name they are shown by, in the host's locale; the (unique) username
 * breaks a tie so the order is the same on every read. */
export function compareHumanLabels(left: HumanNames, right: HumanNames): number {
  return (
    labelCollator.compare(humanLabel(left), humanLabel(right)) ||
    (left.username < right.username ? -1 : left.username > right.username ? 1 : 0)
  );
}
