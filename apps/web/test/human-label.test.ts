import { expect, test } from "bun:test";

import { compareHumanLabels, humanLabel } from "#src/lib/human-label";

test("a person is named by their display name, trimmed", () => {
  expect(humanLabel({ displayName: "  Ada Lovelace ", fullName: null, username: "ada" })).toBe(
    "Ada Lovelace",
  );
});

test("a person with no display name and no full name, or blank ones, is named by their username", () => {
  expect(humanLabel({ displayName: null, fullName: null, username: "ada" })).toBe("ada");
  expect(humanLabel({ displayName: undefined, fullName: null, username: "ada" })).toBe("ada");
  expect(humanLabel({ displayName: "   ", fullName: "  ", username: "ada" })).toBe("ada");
});

test("a full name sits between the display name and the username", () => {
  expect(humanLabel({ displayName: "Countess", fullName: "Ada Lovelace", username: "ada" })).toBe(
    "Countess",
  );
  expect(humanLabel({ displayName: " ", fullName: " Ada Lovelace ", username: "ada" })).toBe(
    "Ada Lovelace",
  );
  expect(humanLabel({ displayName: null, fullName: "", username: "ada" })).toBe("ada");
});

test("a row that carries more than the naming fields can be passed as it is", () => {
  const row = {
    id: "user-1",
    username: "ada",
    displayName: "Ada",
    fullName: null,
    avatarObjectKey: null,
  };
  expect(humanLabel(row)).toBe("Ada");
});

test("people sort by the name they are shown by, not by their username", () => {
  const people = [
    { username: "amy", displayName: "Zoe", fullName: null },
    { username: "zed", displayName: null, fullName: "Alice" },
    { username: "mia", displayName: null, fullName: null },
  ];
  expect([...people].sort(compareHumanLabels).map(humanLabel)).toEqual(["Alice", "mia", "Zoe"]);
});

test("labels that differ only in case sort together, and the username settles a tie", () => {
  const people = [
    { username: "b-alex", displayName: "Alex", fullName: null },
    { username: "a-alex", displayName: null, fullName: "alex" },
    { username: "aaron", displayName: null, fullName: null },
  ];
  expect([...people].sort(compareHumanLabels).map((person) => person.username)).toEqual([
    "aaron",
    "a-alex",
    "b-alex",
  ]);
});
