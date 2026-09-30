import { describe, expect, test } from "bun:test";

import { matchSearchEntities, type SearchEntity } from "#src/features/search/search-entities";

const dm = (fields: { name: string; fullName: string | null }): SearchEntity => ({
  kind: "dm",
  id: "dm-1",
  peerId: "user-1",
  avatarUrl: null,
  ...fields,
});

const agent: SearchEntity = {
  kind: "agent",
  id: "agent-1",
  name: "Atlas Bot",
  handle: "atlas",
  avatarUrl: null,
  ownedByCurrentUser: true,
  dmId: null,
};

describe("matchSearchEntities", () => {
  test("a direct message is found by the name shown for the person", () => {
    const entity = dm({ name: "Amazing Grace", fullName: "Grace Hopper" });
    expect(matchSearchEntities([entity], "amazing")).toEqual([entity]);
    expect(matchSearchEntities([entity], "grace")).toEqual([entity]);
  });

  test("and by the full name a nickname replaced", () => {
    const entity = dm({ name: "Amazing Grace", fullName: "Grace Hopper" });
    expect(matchSearchEntities([entity], "hopper")).toEqual([entity]);
  });

  test("a person with no full name matches by the name shown alone", () => {
    const entity = dm({ name: "Ada", fullName: null });
    expect(matchSearchEntities([entity], "ada")).toEqual([entity]);
    expect(matchSearchEntities([entity], "lovelace")).toEqual([]);
  });

  test("an Agent is still found by its @handle", () => {
    expect(matchSearchEntities([agent], "atl")).toEqual([agent]);
    expect(matchSearchEntities([agent], "@atlas")).toEqual([agent]);
  });
});
