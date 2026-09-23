import { describe, expect, test } from "bun:test";

import { canDirectMessageAgent } from "../src/server/agents/agent-visibility.server";

/**
 * The stricter DM predicate: unlike `canSeeAgent` (which also admits an owner/admin
 * viewer), a private Agent's direct conversation stays scoped to its own creator — an owner/admin
 * who can see and manage another member's private Agent still may not open or send a DM with it.
 */
describe("canDirectMessageAgent", () => {
  test("a public Agent can always be direct-messaged", () => {
    expect(canDirectMessageAgent("user-2", { visibility: "public", ownerId: "user-1" })).toBeTrue();
  });

  test("the creator can always direct-message their own Agent, public or private", () => {
    expect(
      canDirectMessageAgent("user-1", { visibility: "private", ownerId: "user-1" }),
    ).toBeTrue();
    expect(canDirectMessageAgent("user-1", { visibility: "public", ownerId: "user-1" })).toBeTrue();
  });

  test("a Workspace owner/admin who is not the creator cannot direct-message a private Agent", () => {
    expect(
      canDirectMessageAgent("user-2", { visibility: "private", ownerId: "user-1" }),
    ).toBeFalse();
  });

  test("an unrecognized visibility value fails closed, like canSeeAgent", () => {
    expect(canDirectMessageAgent("user-2", { visibility: "weird", ownerId: "user-1" })).toBeFalse();
  });
});
