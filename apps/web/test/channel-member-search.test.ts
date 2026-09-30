import { describe, expect, test } from "bun:test";

import { memberMatchesSearch } from "#src/features/conversations/channel-member-search";

/** A person as the members page lists them: `displayName` is the label teammates see. The
 * username rides along on a row read from an older payload; a search must not read it. */
const person = {
  kind: "user" as const,
  displayName: "Frankie",
  fullName: "Frank An",
  username: "frank-an-4k2",
};

const agent = { kind: "agent" as const, displayName: "Atlas Bot", name: "atlas" };

describe("memberMatchesSearch", () => {
  test("everything matches an empty search", () => {
    expect(memberMatchesSearch("", person)).toBeTrue();
    expect(memberMatchesSearch("", agent)).toBeTrue();
  });

  test("a person matches by the label they are shown by", () => {
    expect(memberMatchesSearch("frankie", person)).toBeTrue();
    expect(memberMatchesSearch("rank", person)).toBeTrue();
  });

  test("a person matches by full name, which the label may have replaced with a nickname", () => {
    expect(memberMatchesSearch("frank an", person)).toBeTrue();
    expect(memberMatchesSearch("an", person)).toBeTrue();
  });

  test("a person is not found by their username", () => {
    expect(memberMatchesSearch("4k2", person)).toBeFalse();
    expect(memberMatchesSearch("frank-an", person)).toBeFalse();
  });

  test("a person with no full name matches by label alone", () => {
    expect(
      memberMatchesSearch("ada", { kind: "user", displayName: "Ada", fullName: null }),
    ).toBeTrue();
    expect(
      memberMatchesSearch("lovelace", { kind: "user", displayName: "Ada", fullName: null }),
    ).toBeFalse();
  });

  test("an Agent matches by display name or by its @handle", () => {
    expect(memberMatchesSearch("atlas bot", agent)).toBeTrue();
    expect(memberMatchesSearch("tla", agent)).toBeTrue();
    expect(memberMatchesSearch("scribe", agent)).toBeFalse();
  });

  test("the search is compared in lower case", () => {
    expect(memberMatchesSearch("frank an", { ...person, fullName: "FRANK AN" })).toBeTrue();
  });
});
