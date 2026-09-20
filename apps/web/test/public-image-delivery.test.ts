import { describe, expect, test } from "bun:test";

import {
  createPublicImageDelivery,
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  PublicImageDeliveryConfigError,
  readPublicImageDeliveryConfig,
} from "../src/server/files/public-image-delivery.server";

test("public image delivery is disabled when the CDN URL is unset", () => {
  expect(readPublicImageDeliveryConfig({})).toBeNull();
  expect(createPublicImageDelivery(readPublicImageDeliveryConfig({}))).toBeNull();
});

test("parses a configured public image CDN URL", () => {
  expect(
    readPublicImageDeliveryConfig({
      COFORGE_IMAGE_DELIVERY_URL: "https://images-staging.coforge.cn/",
    }),
  ).toEqual({ baseUrl: "https://images-staging.coforge.cn" });
});

test("rejects http, a path, a query, and a hash", () => {
  for (const url of [
    "http://images-staging.coforge.cn",
    "https://images-staging.coforge.cn/images",
    "https://images-staging.coforge.cn?x=1",
    "https://images-staging.coforge.cn#x",
  ]) {
    expect(() => readPublicImageDeliveryConfig({ COFORGE_IMAGE_DELIVERY_URL: url })).toThrow(
      PublicImageDeliveryConfigError,
    );
  }
});

test("rejects the signed attachment domain, which refuses an unsigned request", () => {
  expect(() =>
    readPublicImageDeliveryConfig({
      COFORGE_IMAGE_DELIVERY_URL: "https://files-staging.coforge.cn",
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn",
    }),
  ).toThrow(PublicImageDeliveryConfigError);
});

test("rejects the application's own origin", () => {
  expect(() =>
    readPublicImageDeliveryConfig({
      COFORGE_IMAGE_DELIVERY_URL: "https://app-staging.coforge.cn",
      AUTHING_REDIRECT_URI: "https://app-staging.coforge.cn/api/auth/callback",
    }),
  ).toThrow(PublicImageDeliveryConfigError);
});

describe("addressing", () => {
  const delivery = createPublicImageDelivery({ baseUrl: "https://images-staging.coforge.cn" })!;

  test("maps one object key onto one path, with no prefix rewrite", () => {
    expect(
      delivery.url("users/user-1/avatars/avatar-1/original", PROFILE_IMAGE_STYLES.avatar),
    ).toBe(
      "https://images-staging.coforge.cn/users/user-1/avatars/avatar-1/original?x-oss-process=style/avatar192",
    );
  });

  test("encodes each path segment", () => {
    expect(delivery.url("users/a b/avatars/c?d/original", PROFILE_IMAGE_STYLES.icon)).toBe(
      "https://images-staging.coforge.cn/users/a%20b/avatars/c%3Fd/original?x-oss-process=style/icon256",
    );
  });

  test("asks for a named style, never a free-form processing expression", () => {
    const url = new URL(
      delivery.url("users/user-1/avatars/avatar-1/original", PROFILE_IMAGE_STYLES.avatar),
    );
    expect(url.searchParams.get("x-oss-process")).toBe("style/avatar192");
    expect([...url.searchParams.keys()]).toEqual(["x-oss-process"]);
  });

  test("the same key and style always yield the same URL, so the browser can cache it", () => {
    const key = "users/user-1/avatars/avatar-1/original";
    expect(delivery.url(key, PROFILE_IMAGE_STYLES.avatar)).toBe(
      delivery.url(key, PROFILE_IMAGE_STYLES.avatar),
    );
  });
});

test("publicImageUrl is null when delivery is not configured, so callers keep the proxy route", () => {
  expect(
    publicImageUrl("users/user-1/avatars/avatar-1/original", PROFILE_IMAGE_STYLES.avatar, null),
  ).toBeNull();
  expect(
    publicImageUrl(
      "users/user-1/avatars/avatar-1/original",
      PROFILE_IMAGE_STYLES.avatar,
      createPublicImageDelivery({ baseUrl: "https://images-staging.coforge.cn" }),
    ),
  ).toBe(
    "https://images-staging.coforge.cn/users/user-1/avatars/avatar-1/original?x-oss-process=style/avatar192",
  );
});
