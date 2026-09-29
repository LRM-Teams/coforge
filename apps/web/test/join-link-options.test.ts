import { describe, expect, test } from "bun:test";

import {
  defaultJoinLinkChoices,
  joinLinkOptions,
} from "#src/features/workspaces/join-link-options";

const NOW = new Date("2026-09-29T08:00:00.000Z");
const limited = { maxUses: 10, expiresAt: new Date("2026-10-06T08:00:00.000Z") };
const open = { maxUses: null, expiresAt: null };

describe("the choices the link tab starts with", () => {
  test("a link without a limit or an expiry starts at no limit and never", () => {
    expect(defaultJoinLinkChoices(open)).toEqual({ maxUses: "unlimited", expiry: "never" });
    expect(defaultJoinLinkChoices(null)).toEqual({ maxUses: "unlimited", expiry: "never" });
  });

  test("a link with a limit and an expiry keeps both", () => {
    expect(defaultJoinLinkChoices(limited)).toEqual({ maxUses: "keep", expiry: "keep" });
  });

  test("each setting is kept on its own", () => {
    expect(defaultJoinLinkChoices({ maxUses: 5, expiresAt: null })).toEqual({
      maxUses: "keep",
      expiry: "never",
    });
  });
});

describe("the link options sent for the chosen settings", () => {
  test("keep sends the current link's limit and expiry", () => {
    expect(
      joinLinkOptions({ maxUses: "keep", expiry: "keep" }, limited, NOW, "Asia/Shanghai"),
    ).toEqual({ maxUses: 10, expiresAt: "2026-10-06T08:00:00.000Z" });
  });

  test("no limit and never send null", () => {
    expect(joinLinkOptions({ maxUses: "unlimited", expiry: "never" }, limited, NOW, "UTC")).toEqual(
      { maxUses: null, expiresAt: null },
    );
  });

  test("keep without a current value sends null", () => {
    expect(joinLinkOptions({ maxUses: "keep", expiry: "keep" }, null, NOW, "UTC")).toEqual({
      maxUses: null,
      expiresAt: null,
    });
  });

  test("a count sends that limit, and days count from now", () => {
    expect(joinLinkOptions({ maxUses: 25, expiry: 7 }, open, NOW, "UTC")).toEqual({
      maxUses: 25,
      expiresAt: "2026-10-06T08:00:00.000Z",
    });
  });

  test("days are calendar days in the viewer's zone, across a daylight-saving change", () => {
    // New York leaves daylight time on 2026-11-01: a day later on the clock is 25 hours later.
    expect(
      joinLinkOptions(
        { maxUses: "unlimited", expiry: 1 },
        open,
        new Date("2026-10-31T16:00:00.000Z"),
        "America/New_York",
      ).expiresAt,
    ).toBe("2026-11-01T17:00:00.000Z");
  });
});
