import { expect, test } from "bun:test";
import {
  describeComputerUpgradeFailure,
  describeUpgradeRequestError,
} from "../src/features/computers/upgrade-failure";
import { AppError } from "../src/lib/app-error";

test("a reported failure shows the Computer's own reason on one line", () => {
  const line = describeComputerUpgradeFailure({
    reason: "reported",
    error: "candidate failed at <path>",
  });

  expect(line).toContain("candidate failed at <path>");
  expect(line.split("\n")).toHaveLength(1);
});

test("each inferred failure reads as its own sentence, never a bare code", () => {
  const lines = (["timeout", "publication", "evidence", "reported"] as const).map((reason) =>
    describeComputerUpgradeFailure({ reason }),
  );

  expect(new Set(lines).size).toBe(4);
  for (const line of lines) {
    expect(line.endsWith(".")).toBe(true);
    expect(line).not.toContain("_");
  }
});

test("an offline Computer reads as a human sentence, never the raw AppError wire encoding", () => {
  const copy = describeUpgradeRequestError(new AppError("COMPUTER_OFFLINE", { errorId: "abc" }));

  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.headline).not.toContain("COMPUTER_OFFLINE");
  expect(copy.headline.length).toBeGreaterThan(0);
  expect(copy.errorId).toBe("abc");
});

test("an unavailable release feed reads as its own sentence", () => {
  const copy = describeUpgradeRequestError(new AppError("RELEASE_FEED_UNAVAILABLE"));

  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.headline).not.toContain("RELEASE_FEED_UNAVAILABLE");
  expect(copy.errorId).toBeUndefined();
});

test("an unrelated AppError falls back to a generic sentence but keeps its reference id discoverable", () => {
  const copy = describeUpgradeRequestError(new AppError("INTERNAL_ERROR", { errorId: "xyz" }));

  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.headline).not.toContain("INTERNAL_ERROR");
  expect(copy.errorId).toBe("xyz");
});

test("a serialized AppError decodes from its wire-encoded message the same way", () => {
  // This is exactly the shape TanStack's shallow Error serialization hands back to the client -
  // a plain Error whose message is the encoded AppError, not an AppError instance.
  const wire = new Error(new AppError("COMPUTER_OFFLINE", { errorId: "wire-id" }).message);

  const copy = describeUpgradeRequestError(wire);

  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.errorId).toBe("wire-id");
});

test("a plain error from a status poll passes through unchanged, since it is already a sentence", () => {
  const copy = describeUpgradeRequestError(
    new Error(describeComputerUpgradeFailure({ reason: "timeout" })),
  );

  expect(copy.headline).toBe(describeComputerUpgradeFailure({ reason: "timeout" }));
  expect(copy.errorId).toBeUndefined();
});
