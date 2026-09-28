import { expect, test } from "bun:test";

import { isAppError } from "#src/lib/app-error";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";

const ROOT = "abcdef12-3456-4789-8abc-def012345678";

test("a six- to eight-hex prefix names the id range it starts, and a full id names itself", () => {
  expect(messageAnchorWhere("abcdef")).toEqual({
    gte: "abcdef00-0000-0000-0000-000000000000",
    lte: "abcdefff-ffff-ffff-ffff-ffffffffffff",
  });
  expect(messageAnchorWhere("abcdef1")).toEqual({
    gte: "abcdef10-0000-0000-0000-000000000000",
    lte: "abcdef1f-ffff-ffff-ffff-ffffffffffff",
  });
  expect(messageAnchorWhere("abcdef12")).toEqual({
    gte: "abcdef12-0000-0000-0000-000000000000",
    lte: "abcdef12-ffff-ffff-ffff-ffffffffffff",
  });
  expect(messageAnchorWhere(ROOT)).toBe(ROOT);
  // Hex is read in any case, as the reminder target grammar allows, and queried lower-case.
  expect(messageAnchorWhere("ABCDEF12")).toEqual(messageAnchorWhere("abcdef12"));
  expect(messageAnchorWhere(ROOT.toUpperCase())).toBe(ROOT);
});

test("anything else is refused rather than widened into a range", () => {
  for (const anchor of [
    "",
    "a",
    "abc",
    "abcde",
    "abcdef123",
    "abcdefgh",
    "not-a-uuid",
    `${ROOT}0`,
  ]) {
    let caught: unknown;
    try {
      messageAnchorWhere(anchor);
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught) && caught.code).toBe("INVALID_INPUT");
  }
});
