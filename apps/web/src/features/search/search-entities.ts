import { nameMatchTier } from "#src/lib/name-match";

/** A place or participant the search page can open directly: a channel, a Computer, an Agent. */
export type SearchEntity =
  | { kind: "channel"; id: string; name: string; description: string; archived: boolean }
  | { kind: "computer"; id: string; name: string; hostname: string; computerKind: string }
  | {
      kind: "agent";
      id: string;
      name: string;
      handle: string;
      avatarUrl: string | null;
      ownedByCurrentUser: boolean;
    };

/** Most matches listed above the messages. */
const SEARCH_ENTITY_LIMIT = 5;

const KIND_ORDER: Record<SearchEntity["kind"], number> = { channel: 0, computer: 1, agent: 2 };

/** A description match ranks below every name match. */
const DESCRIPTION_TIER = 4;

function matchTier(entity: SearchEntity, lowerQuery: string): number | undefined {
  switch (entity.kind) {
    case "channel":
      return (
        nameMatchTier(entity.name, [], lowerQuery) ??
        (entity.description.toLowerCase().includes(lowerQuery) ? DESCRIPTION_TIER : undefined)
      );
    case "computer":
      return nameMatchTier(entity.name, [entity.hostname], lowerQuery);
    case "agent":
      return nameMatchTier(entity.name, [entity.handle], lowerQuery);
  }
}

/**
 * The entities a query names, best first: closer name matches (`nameMatchTier`), then channels,
 * Computers and Agents in that order, then by name. A leading `#` keeps only channels and a
 * leading `@` only Agents, the way references are written in a message.
 */
export function matchSearchEntities(
  entities: readonly SearchEntity[],
  query: string,
): SearchEntity[] {
  const trimmed = query.trim();
  const only = trimmed.startsWith("#") ? "channel" : trimmed.startsWith("@") ? "agent" : undefined;
  const lowerQuery = trimmed
    .replace(/^[#@]+/, "")
    .trim()
    .toLowerCase();
  if (!lowerQuery) return [];
  return entities
    .filter((entity) => !only || entity.kind === only)
    .flatMap((entity) => {
      const tier = matchTier(entity, lowerQuery);
      return tier === undefined ? [] : [{ entity, tier }];
    })
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        KIND_ORDER[left.entity.kind] - KIND_ORDER[right.entity.kind] ||
        left.entity.name.localeCompare(right.entity.name),
    )
    .slice(0, SEARCH_ENTITY_LIMIT)
    .map(({ entity }) => entity);
}
