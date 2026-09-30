import { expect, test } from "bun:test";

import { compareHumanLabels, humanLabel } from "#src/lib/human-label";

test("a person is named by their display name, trimmed", () => {
  expect(humanLabel({ displayName: "  Ada Lovelace ", username: "ada" })).toBe("Ada Lovelace");
});

test("a person with no display name, or a blank one, is named by their username", () => {
  expect(humanLabel({ displayName: null, username: "ada" })).toBe("ada");
  expect(humanLabel({ displayName: undefined, username: "ada" })).toBe("ada");
  expect(humanLabel({ displayName: "   ", username: "ada" })).toBe("ada");
  expect(humanLabel({ username: "ada" })).toBe("ada");
});

test("a full name, when the caller has one, sits between the display name and the username", () => {
  expect(humanLabel({ displayName: "Countess", fullName: "Ada Lovelace", username: "ada" })).toBe(
    "Countess",
  );
  expect(humanLabel({ displayName: " ", fullName: " Ada Lovelace ", username: "ada" })).toBe(
    "Ada Lovelace",
  );
  expect(humanLabel({ displayName: null, fullName: "", username: "ada" })).toBe("ada");
});

test("a row that carries more than the naming fields can be passed as it is", () => {
  const row = { id: "user-1", username: "ada", displayName: "Ada", avatarObjectKey: null };
  expect(humanLabel(row)).toBe("Ada");
});

test("people sort by the name they are shown by, not by their username", () => {
  const people = [
    { username: "amy", displayName: "Zoe" },
    { username: "zed", displayName: "Alice" },
    { username: "mia", displayName: null },
  ];
  expect([...people].sort(compareHumanLabels).map(humanLabel)).toEqual(["Alice", "mia", "Zoe"]);
});

test("labels that differ only in case sort together, and the username settles a tie", () => {
  const people = [
    { username: "b-alex", displayName: "Alex" },
    { username: "a-alex", displayName: "alex" },
    { username: "aaron", displayName: null },
  ];
  expect([...people].sort(compareHumanLabels).map((person) => person.username)).toEqual([
    "aaron",
    "a-alex",
    "b-alex",
  ]);
});
