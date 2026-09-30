import { resolveUsernameBase, smallestFree } from "./username-allocation.server";

/** A person as the rename reads them: what names them, and the Agent names they must not share. */
export type RenameCandidate = {
  id: string;
  username: string;
  email: string | null;
  fullName: string | null;
  displayName: string | null;
  createdAt: Date;
  /** The names of the live Agents in every Workspace the person belongs to. */
  agentNames: readonly string[];
};

/** Where a new username came from. */
export const RENAME_SOURCES = [
  "current-name",
  "email",
  "old-name",
  "full-name",
  "display-name",
  "fallback",
] as const;
export type RenameSource = (typeof RENAME_SOURCES)[number];

export type UsernameRename = { userId: string; from: string; to: string; source: RenameSource };

/**
 * Who is renamed, and to what. A person is left alone when their name is already the one the
 * allocator's rules give them (see `readableBase`) and no live Agent of a Workspace they belong to
 * has it; everyone else gets the smallest free `-N` of their base, oldest account first.
 *
 * No name is freed by the plan: a new name is never one any account has now, so the updates can
 * run in any order without a moment when two users share a name (the unique index is checked per
 * row), and a mention's text or another copy is never mapped through a chain of renames.
 */
export function planUsernameRenames(people: readonly RenameCandidate[]): UsernameRename[] {
  const taken = new TakenNames(people.map((person) => person.username));
  const plan: UsernameRename[] = [];
  for (const person of [...people].sort(oldestFirst)) {
    const { base, source } = readableBase(person);
    if (base === person.username && !person.agentNames.includes(base)) continue;
    const to = smallestFree(base, [...taken.around(base), ...person.agentNames]);
    taken.add(to);
    plan.push({ userId: person.id, from: person.username, to, source });
  }
  return plan;
}

const oldestFirst = (left: RenameCandidate, right: RenameCandidate) =>
  left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);

/** Names by what `smallestFree` asks about a base: the name itself, and its `-N` stem. */
class TakenNames {
  private readonly byBase = new Map<string, Set<string>>();

  constructor(names: Iterable<string>) {
    for (const name of names) this.add(name);
  }

  add(name: string) {
    for (const base of new Set([name, name.replace(/-\d+$/, "")])) {
      const names = this.byBase.get(base) ?? new Set<string>();
      names.add(name);
      this.byBase.set(base, names);
    }
  }

  /** Every name that is `base` or `base-N`. */
  around(base: string): Iterable<string> {
    return this.byBase.get(base) ?? [];
  }
}

/**
 * The base the allocator would give this person. The database has no `preferred_username`, the
 * allocator's first source, so a username the sign-in did not build from the account's id stands
 * in for it; and the email local part an id-suffixed name was built from stands in for an email
 * the account has not stored yet.
 */
function readableBase(person: RenameCandidate): { base: string; source: RenameSource } {
  const derived = idDerivedName(person);
  const { base, source } = resolveUsernameBase({
    preferredUsername: derived ? undefined : person.username,
    email: person.email ?? derived?.stem,
    name: person.fullName,
    nickname: person.displayName,
  });
  switch (source) {
    case "preferred_username":
      return { base, source: "current-name" };
    case "email":
      return { base, source: person.email ? "email" : "old-name" };
    case "name":
      return { base, source: "full-name" };
    case "nickname":
      return { base, source: "display-name" };
    case "fallback":
      return { base, source: "fallback" };
  }
}

/**
 * Before readable names a username was built from the account's id: `<email local part>-<first 8
 * hex digits of the id>`, or `user-<all 32>`. Such a name says nothing the person chose; `stem` is
 * the local part it was built from.
 */
function idDerivedName(person: RenameCandidate): { stem?: string } | undefined {
  const hex = person.id.replaceAll("-", "").toLowerCase();
  if (person.username === `user-${hex}`) return {};
  const suffix = `-${hex.slice(0, 8)}`;
  if (person.username.endsWith(suffix)) {
    const stem = person.username.slice(0, -suffix.length);
    return stem ? { stem } : {};
  }
  return undefined;
}
