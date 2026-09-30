import { nameToSlug } from "#src/lib/slug";
import { USERNAME_PATTERN } from "#src/lib/username-grammar";
import { isReservedWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

/** What a sign-in tells us about a person that can name their account. */
export type UsernameProfile = {
  preferredUsername?: string | null;
  email?: string | null;
  name?: string | null;
  nickname?: string | null;
};

/** Room for `-NNNNNNN` under the grammar's 32-character limit. */
const BASE_MAX_LENGTH = 24;
/** Room for `-` and 8 hex characters. */
const HEX_SUFFIXED_BASE_MAX_LENGTH = 23;
/** Times a create that lost a race is tried again with the next free name before the hex suffix. */
const COLLISION_RETRIES = 5;
const FALLBACK_BASE = "user";

/** Names that would read as something other than a person in a mention or a URL. `user` is not
 * one: it is the last-resort base, and takes the same `-N` suffix as any other. */
const RESERVED_USERNAMES = new Set([
  "admin",
  "agent",
  "all",
  "channel",
  "channels",
  "coforge",
  "everyone",
  "general",
  "group",
  "groups",
  "here",
  "human",
  "me",
  "system",
  "you",
]);

/**
 * The readable base name for a new account: the first of the person's `preferred_username`, the
 * local part of their email, and their name or nickname that yields a name the grammar allows,
 * else `user`. It is a pure function of the profile, so the same rule holds for every source.
 */
export function usernameBase(profile: UsernameProfile): string {
  const candidates = [
    strictName(profile.preferredUsername),
    normalizedName(emailLocalPart(profile.email)),
    asciiSlug(profile.name),
    asciiSlug(profile.nickname),
  ];
  for (const candidate of candidates) {
    const base = candidate && allowedBase(candidate);
    if (base) return base;
  }
  return FALLBACK_BASE;
}

/**
 * Hands out the smallest free readable username and runs the caller's create with it. Uniqueness
 * is the database's: a create that loses a race on the name is tried again with the next free
 * one, so nothing is locked.
 */
export class UsernameAllocator {
  /** `takenAround` lists the stored usernames equal to `base` or starting with `base-`. */
  constructor(private readonly takenAround: (base: string) => Promise<string[]>) {}

  /**
   * Calls `create` with a free username and returns its result. `create` throws a unique
   * violation when the name was taken meanwhile; any other error is the caller's and is not
   * retried.
   */
  async create<T>(profile: UsernameProfile, create: (username: string) => Promise<T>): Promise<T> {
    const base = usernameBase(profile);
    for (let attempt = 0; attempt < COLLISION_RETRIES; attempt += 1) {
      const username = smallestFree(base, await this.takenAround(base));
      try {
        return await create(username);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    const stem = base.slice(0, HEX_SUFFIXED_BASE_MAX_LENGTH).replace(/[-_]+$/, "");
    return create(`${stem}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`);
  }
}

/** The base, else `base-2`, `base-3`, ...: only these count as taken, so `ada3x` and an older
 * `ada3-d9956ab1` never block `ada3`. */
function smallestFree(base: string, taken: string[]): string {
  const numbers = new Set<number>();
  let baseTaken = false;
  for (const name of taken) {
    if (name === base) baseTaken = true;
    else if (name.startsWith(`${base}-`)) {
      const rest = name.slice(base.length + 1);
      if (/^\d+$/.test(rest)) numbers.add(Number(rest));
    }
  }
  if (!baseTaken) return base;
  let next = 2;
  while (numbers.has(next)) next += 1;
  return `${base}-${next}`;
}

/** A `preferred_username` is not rewritten into a name the way an email or a name is: it is
 * lower-cased and used only if it already looks like one. Like every source it may still get the
 * `u` prefix or a cut to 24 characters (`allowedBase`). */
function strictName(value: string | null | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

/** Lower-case, every other run of characters becomes one `-`, no separator at either end. */
function normalizedName(value: string | undefined): string | undefined {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function emailLocalPart(email: string | null | undefined): string | undefined {
  return email?.split("@", 1)[0]?.split("+", 1)[0];
}

/** The ASCII part of a name as a slug; a name with no ASCII letters or digits yields nothing.
 * Uncut, so a phone number late in a long name is still seen (`allowedBase` cuts it). */
function asciiSlug(name: string | null | undefined): string | undefined {
  return name ? nameToSlug(name, name.length) : undefined;
}

/** A candidate that reads as a name, made to fit the grammar; undefined when it cannot be. */
function allowedBase(candidate: string): string | undefined {
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(candidate)) return undefined;
  if (looksLikePhoneNumber(candidate)) return undefined;
  const lettered = /^[0-9]/.test(candidate) ? `u${candidate}` : candidate;
  const base = lettered.slice(0, BASE_MAX_LENGTH).replace(/[-_]+$/, "");
  return USERNAME_PATTERN.test(base) && !isReserved(base) ? base : undefined;
}

/** A run of eleven or more digits, however it is spaced or surrounded (`wx13800138000`,
 * `tel-138-0013-8000`), may be a phone number. The username is in every `@` mention and the
 * personal Workspace's slug, so such a value is never used. A candidate is already normalised, so
 * `-` and `_` are the only separators left to see through. */
function looksLikePhoneNumber(candidate: string): boolean {
  return /[0-9]{11}/.test(candidate.replace(/[-_]/g, ""));
}

function isReserved(base: string): boolean {
  return RESERVED_USERNAMES.has(base) || isReservedWorkspaceSlug(base);
}
