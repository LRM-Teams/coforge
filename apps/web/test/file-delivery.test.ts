import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  CdnTypeAFileDelivery,
  createFileDelivery,
  FILE_DELIVERY_TTL_SECONDS,
  FileDeliveryConfigError,
  fileDeliveryStatus,
  getFileDelivery,
  readFileDeliveryConfig,
  rememberFileDeliveryConfig,
} from "@/server/files/file-delivery.server";

test("delivery is disabled when the CDN URL is unset", async () => {
  expect(await readFileDeliveryConfig({})).toBeNull();
  expect(createFileDelivery(await readFileDeliveryConfig({}))).toBeNull();
});

test("an unpublished secret file is not reported as delivery disabled", () => {
  const previousUrl = process.env.COFORGE_FILE_DELIVERY_URL;
  const previousKey = process.env.COFORGE_FILE_DELIVERY_KEY;
  const previousKeyFile = process.env.COFORGE_FILE_DELIVERY_KEY_FILE;
  // Publishing null is the only public way to drop a config remembered by an earlier test.
  // The lookup below must not treat that as "CDN off", and must not read the secret file.
  rememberFileDeliveryConfig(null);
  process.env.COFORGE_FILE_DELIVERY_URL = "https://files-staging.coforge.cn";
  delete process.env.COFORGE_FILE_DELIVERY_KEY;
  process.env.COFORGE_FILE_DELIVERY_KEY_FILE = "/run/secrets/coforge_file_delivery_key";
  try {
    expect(fileDeliveryStatus()).toEqual({ state: "unavailable" });
    expect(getFileDelivery()).toBeNull();
    rememberFileDeliveryConfig({
      baseUrl: "https://files-staging.coforge.cn",
      key: "primarykey",
    });
    expect(fileDeliveryStatus()).toEqual({ state: "configured" });
    expect(getFileDelivery()?.signedUrl("workspaces/w/attachments/a/original").url).toContain(
      "auth_key=",
    );
  } finally {
    restoreEnv("COFORGE_FILE_DELIVERY_URL", previousUrl);
    restoreEnv("COFORGE_FILE_DELIVERY_KEY", previousKey);
    restoreEnv("COFORGE_FILE_DELIVERY_KEY_FILE", previousKeyFile);
    rememberFileDeliveryConfig(null);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("parses a configured CDN delivery URL and key", async () => {
  expect(
    await readFileDeliveryConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn",
      COFORGE_FILE_DELIVERY_KEY: "primarykey",
    }),
  ).toEqual({
    baseUrl: "https://files-staging.coforge.cn",
    key: "primarykey",
  });
});

test("strips exactly one trailing slash from the CDN URL", async () => {
  expect(
    (
      await readFileDeliveryConfig({
        COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn/",
        COFORGE_FILE_DELIVERY_KEY: "k",
      })
    )?.baseUrl,
  ).toBe("https://files-staging.coforge.cn");
});

test("rejects http, a path/query/hash, and a missing key", async () => {
  await expect(
    readFileDeliveryConfig({
      COFORGE_FILE_DELIVERY_URL: "http://files-staging.coforge.cn",
      COFORGE_FILE_DELIVERY_KEY: "k",
    }),
  ).rejects.toThrow(FileDeliveryConfigError);

  await expect(
    readFileDeliveryConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn/objects",
      COFORGE_FILE_DELIVERY_KEY: "k",
    }),
  ).rejects.toThrow(FileDeliveryConfigError);

  await expect(
    readFileDeliveryConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn?x=1",
      COFORGE_FILE_DELIVERY_KEY: "k",
    }),
  ).rejects.toThrow(FileDeliveryConfigError);

  await expect(
    readFileDeliveryConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn#frag",
      COFORGE_FILE_DELIVERY_KEY: "k",
    }),
  ).rejects.toThrow(FileDeliveryConfigError);

  await expect(
    readFileDeliveryConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn",
    }),
  ).rejects.toThrow(FileDeliveryConfigError);
});

test("Type A signing matches Alibaba Cloud's algorithm against a fixed clock, key, and rand", () => {
  expect(FILE_DELIVERY_TTL_SECONDS).toBe(1800);
  const delivery = new CdnTypeAFileDelivery(
    { baseUrl: "https://files-staging.coforge.cn", key: "primarykey" },
    () => "rand1234",
  );
  const now = new Date(1700000000 * 1000);

  const { url, expiresAt } = delivery.signedUrl("workspaces/w/attachments/a/original", now);

  const expectedMd5 = createHash("md5")
    .update("/workspaces/w/attachments/a/original-1700000000-rand1234-0-primarykey")
    .digest("hex");
  expect(url).toBe(
    "https://files-staging.coforge.cn/workspaces/w/attachments/a/original" +
      `?auth_key=1700000000-rand1234-0-${expectedMd5}`,
  );
  expect(expiresAt).toEqual(new Date((1700000000 + FILE_DELIVERY_TTL_SECONDS) * 1000));
});

test("encodes each object-key path segment consistently for the hash input and the URL", () => {
  const delivery = new CdnTypeAFileDelivery(
    { baseUrl: "https://files-staging.coforge.cn", key: "k+ey/with-specials" },
    () => "r",
  );
  const now = new Date(1000 * 1000);
  const objectKey = "workspaces/w+1/attachments/a b/original";

  const { url } = delivery.signedUrl(objectKey, now);

  const encodedUri = "/workspaces/w%2B1/attachments/a%20b/original";
  const expectedMd5 = createHash("md5")
    .update(`${encodedUri}-1000-r-0-k+ey/with-specials`)
    .digest("hex");
  expect(url).toBe(
    `https://files-staging.coforge.cn${encodedUri}?auth_key=1000-r-0-${expectedMd5}`,
  );
});

describe("delivery must not be the application's own origin", () => {
  // A signed delivery URL can be framed as a document (a PDF in the browser's own viewer, which
  // cannot be sandboxed). On the application's own host such a document would reach the session
  // cookies, which is exactly what the inline-type refusal exists to prevent, so a deployment that
  // points delivery at that host is refused rather than trusted.
  test("a delivery origin different from the application origin is accepted", async () => {
    expect(
      await readFileDeliveryConfig({
        COFORGE_FILE_DELIVERY_URL: "https://files.coforge.cn",
        COFORGE_FILE_DELIVERY_KEY: "k".repeat(32),
        AUTHING_REDIRECT_URI: "https://app.coforge.cn/auth/callback",
      } as NodeJS.ProcessEnv),
    ).toEqual({ baseUrl: "https://files.coforge.cn", key: "k".repeat(32) });
  });

  test("a delivery origin equal to the application origin is refused", async () => {
    await expect(
      readFileDeliveryConfig({
        COFORGE_FILE_DELIVERY_URL: "https://app.coforge.cn",
        COFORGE_FILE_DELIVERY_KEY: "k".repeat(32),
        AUTHING_REDIRECT_URI: "https://app.coforge.cn/auth/callback",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow("must not be the application's own origin");
  });

  test("without a configured application origin there is nothing to compare", async () => {
    expect(
      await readFileDeliveryConfig({
        COFORGE_FILE_DELIVERY_URL: "https://files.coforge.cn",
        COFORGE_FILE_DELIVERY_KEY: "k".repeat(32),
      } as NodeJS.ProcessEnv),
    ).toEqual({ baseUrl: "https://files.coforge.cn", key: "k".repeat(32) });
  });
});
