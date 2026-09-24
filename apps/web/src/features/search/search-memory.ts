import { lastSearchSchema, type LastSearch } from "./search.schemas";

/**
 * What the search page remembers in this browser, per Workspace and viewer: the searches that led
 * somewhere (history) and the channels and Agents opened from search (usage, which ranks the
 * "Frequently used" list). Device-local conveniences only, like the Chat layout sizes; nothing is
 * sent to the server. Every read and write tolerates storage that is missing, full or blocked.
 */

/** A remembered place: `channel:<id>` or `agent:<id>`. */
export type SearchEntityKey = `${"channel" | "agent"}:${string}`;

/** A place search remembers: a channel or an Agent (Computers are not remembered). */
export type RememberedEntity = { kind: "channel" | "agent"; id: string };

/** The key a place is remembered under, or `undefined` for a kind search does not remember. */
export function searchEntityKey(entity: { kind: string; id: string }): SearchEntityKey | undefined {
  return entity.kind === "channel" || entity.kind === "agent"
    ? `${entity.kind}:${entity.id}`
    : undefined;
}

const HISTORY_LIMIT = 15;
const HISTORY_ENTRY_LENGTH = 200;
const OPENS_PER_ENTITY = 24;
const ENTITY_LIMIT = 64;
const FREQUENT_LIMIT = 10;
const DAY_MS = 86_400_000;
/** Opens older than this no longer count. */
const USAGE_WINDOW_MS = 90 * DAY_MS;
/** An open counts half as much after a week. */
const HALF_LIFE_MS = 7 * DAY_MS;
/** Opens stamped this far ahead still count: a clock that stepped back must not wipe them. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export type SearchUsage = Record<string, number[]>;

/** Whether a `storage` event's key is one of this page's lists (`null` is a whole clear). */
export function isSearchMemoryKey(key: string | null, workspaceId: string, userId: string) {
  return (
    key === null || key === historyKey(workspaceId, userId) || key === usageKey(workspaceId, userId)
  );
}

function lastSearchKey(workspaceId: string, userId: string) {
  return `coforge:search-last:${workspaceId}:${userId}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The last search, parsed like the page's own URL: unknown fields and bad values are dropped. */
export function readLastSearch(workspaceId: string, userId: string): LastSearch {
  const stored = read(lastSearchKey(workspaceId, userId), isObject, {});
  const parsed = lastSearchSchema.safeParse(stored);
  return parsed.success ? parsed.data : {};
}

export function writeLastSearch(workspaceId: string, userId: string, search: LastSearch) {
  write(lastSearchKey(workspaceId, userId), search);
}

function historyKey(workspaceId: string, userId: string) {
  return `coforge:search-history:${workspaceId}:${userId}`;
}

function usageKey(workspaceId: string, userId: string) {
  return `coforge:search-usage:${workspaceId}:${userId}`;
}

function read<T>(key: string, valid: (value: unknown) => value is T, fallback: T): T {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : fallback;
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or blocked: the page just remembers less.
  }
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isUsage = (value: unknown): value is SearchUsage =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(
    (opens) => Array.isArray(opens) && opens.every((open) => typeof open === "number"),
  );

export function readSearchHistory(workspaceId: string, userId: string): string[] {
  return read(historyKey(workspaceId, userId), isStringList, []);
}

export function writeSearchHistory(workspaceId: string, userId: string, history: string[]) {
  write(historyKey(workspaceId, userId), history);
}

/** The history with `query` first; the same text in any case counts once. */
export function withSearch(history: readonly string[], query: string): string[] {
  const entry = query.trim().slice(0, HISTORY_ENTRY_LENGTH);
  if (!entry) return [...history];
  const key = entry.toLowerCase();
  return [entry, ...history.filter((item) => item.toLowerCase() !== key)].slice(0, HISTORY_LIMIT);
}

export function readSearchUsage(workspaceId: string, userId: string): SearchUsage {
  return read(usageKey(workspaceId, userId), isUsage, {});
}

export function writeSearchUsage(workspaceId: string, userId: string, usage: SearchUsage) {
  write(usageKey(workspaceId, userId), usage);
}

/**
 * The usage with one more open of `entity` at `now`. Keeps the newest opens within the window,
 * and only the most recently opened places once there are too many.
 */
export function withOpen(usage: SearchUsage, entity: SearchEntityKey, now: number): SearchUsage {
  const entries = Object.entries({
    ...usage,
    [entity]: [now, ...(usage[entity] ?? [])].slice(0, OPENS_PER_ENTITY),
  })
    .map(([key, opens]) => [key, recentOpens(opens, now)] as const)
    .filter(([, opens]) => opens.length > 0)
    // Opens are kept newest first, so the first is the latest.
    .sort(([, left], [, right]) => right[0]! - left[0]!)
    .slice(0, ENTITY_LIMIT);
  return Object.fromEntries(entries);
}

/** The opens still inside the window, newest first. */
function recentOpens(opens: readonly number[], now: number): number[] {
  return opens.filter((open) => now - open <= USAGE_WINDOW_MS && open - now <= FUTURE_TOLERANCE_MS);
}

/** A remembered key back as its place; `undefined` for a key this page never writes. */
function parseEntityKey(key: string): RememberedEntity | undefined {
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon);
  const id = key.slice(colon + 1);
  return colon > 0 && id && (kind === "channel" || kind === "agent") ? { kind, id } : undefined;
}

/**
 * The places opened most, weighing each open by its age (half as much after a week), best first;
 * ties go to the most recently opened. `usable` drops places that can no longer be shown (gone,
 * or an archived channel) before the ten are picked, so they never take a slot.
 */
export function frequentEntities(
  usage: SearchUsage,
  now: number,
  usable: (entity: RememberedEntity) => boolean,
): RememberedEntity[] {
  return Object.entries(usage)
    .flatMap(([key, opens]) => {
      const entity = parseEntityKey(key);
      if (!entity || !usable(entity)) return [];
      const recent = recentOpens(opens, now);
      const score = recent.reduce((sum, open) => sum + 2 ** (-(now - open) / HALF_LIFE_MS), 0);
      return score > 0 ? [{ entity, score, latest: recent[0]! }] : [];
    })
    .sort((left, right) => right.score - left.score || right.latest - left.latest)
    .slice(0, FREQUENT_LIMIT)
    .map((entry) => entry.entity);
}
