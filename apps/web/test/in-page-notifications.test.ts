import { describe, expect, test } from "bun:test";

import {
  isInPageNotificationEnabled,
  shouldShowInPageNotification,
} from "#src/features/notifications/in-page-notifications";

describe("isInPageNotificationEnabled", () => {
  test("requires both the preference and a granted browser permission", () => {
    expect(isInPageNotificationEnabled({ enabled: true, permission: "granted" })).toBe(true);
    expect(isInPageNotificationEnabled({ enabled: false, permission: "granted" })).toBe(false);
    expect(isInPageNotificationEnabled({ enabled: true, permission: "default" })).toBe(false);
    expect(isInPageNotificationEnabled({ enabled: true, permission: "denied" })).toBe(false);
    expect(isInPageNotificationEnabled({ enabled: true, permission: "unsupported" })).toBe(false);
  });
});

describe("shouldShowInPageNotification", () => {
  test("shows when the tab is not the visible, focused conversation it is about", () => {
    expect(
      shouldShowInPageNotification({
        visible: false,
        focused: false,
        pathname: "/w/acme/channel/a",
        conversationPath: "/w/acme/channel/a",
      }),
    ).toBe(true);
    expect(
      shouldShowInPageNotification({
        visible: true,
        focused: true,
        pathname: "/w/acme/channel/other",
        conversationPath: "/w/acme/channel/a",
      }),
    ).toBe(true);
    expect(
      shouldShowInPageNotification({
        visible: true,
        focused: false,
        pathname: "/w/acme/channel/a",
        conversationPath: "/w/acme/channel/a",
      }),
    ).toBe(true);
  });

  test("skips only while visible, focused, and already looking at that conversation", () => {
    expect(
      shouldShowInPageNotification({
        visible: true,
        focused: true,
        pathname: "/w/acme/channel/a",
        conversationPath: "/w/acme/channel/a",
      }),
    ).toBe(false);
  });
});
