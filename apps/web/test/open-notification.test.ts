import { describe, expect, test } from "bun:test";

import { notificationOpenResponse } from "../src/server/notifications/open-notification.server";

const target = "/messages/channels/01991890-89ec-7000-8000-000000000001";

describe("notificationOpenResponse", () => {
  test("selects an accessible workspace before opening the message", async () => {
    const response = await notificationOpenResponse({
      request: new Request(
        `https://coforge.example/notifications/open?workspace=acme&target=${encodeURIComponent(target)}`,
      ),
      userId: "user-a",
      canAccessWorkspace: async (userId, slug) => userId === "user-a" && slug === "acme",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(target);
    expect(response.headers.get("set-cookie")).toContain("coforge_workspace=acme");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  test("does not select or open inaccessible and malformed targets", async () => {
    for (const url of [
      `https://coforge.example/notifications/open?workspace=other&target=${encodeURIComponent(target)}`,
      "https://coforge.example/notifications/open?workspace=acme&target=https://evil.example",
    ]) {
      const response = await notificationOpenResponse({
        request: new Request(url),
        userId: "user-a",
        canAccessWorkspace: async (_userId, slug) => slug === "acme",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      expect(response.headers.has("set-cookie")).toBe(false);
    }
  });
});
