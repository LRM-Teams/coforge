/** A channel member as a search reads them. A person is found by the label they are shown by and
 * by their full name (the label may be a nickname that replaced it); a username is a generated
 * handle nobody types, so it is not searched. An Agent is found by its display name and its
 * `@handle`, which is how it is mentioned. */
export type SearchableMember =
  | { kind: "user"; displayName: string; fullName: string | null }
  | { kind: "agent"; displayName: string; name: string };

/** Whether `member` answers `query`, already trimmed and in lower case; an empty query answers
 * everyone. */
export function memberMatchesSearch(query: string, member: SearchableMember): boolean {
  if (!query) return true;
  const names =
    member.kind === "agent"
      ? [member.displayName, member.name]
      : [member.displayName, member.fullName ?? ""];
  return names.some((name) => name.toLowerCase().includes(query));
}
