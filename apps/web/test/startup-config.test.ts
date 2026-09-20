import { expect, test } from "bun:test";

import { FileDeliveryConfigError } from "../src/server/files/file-delivery.server";
import { FileStorageConfigError } from "../src/server/files/file-storage.server";
import { PublicImageDeliveryConfigError } from "../src/server/files/public-image-delivery.server";
import { assertStartupConfig } from "../src/server/startup-config.server";

test("boots without CDN delivery when it is not configured", () => {
  expect(() => assertStartupConfig({})).not.toThrow();
});

test("refuses to boot when the delivery URL is set but its signing key is missing", () => {
  expect(() =>
    assertStartupConfig({ COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn" }),
  ).toThrow(FileDeliveryConfigError);
});

test("refuses to boot when the signing key file cannot be read", () => {
  expect(() =>
    assertStartupConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn",
      COFORGE_FILE_DELIVERY_KEY_FILE: "/nonexistent/coforge_file_delivery_key",
    }),
  ).toThrow(FileDeliveryConfigError);
});

test("refuses to boot when public image URLs would point at a bucket the image domain cannot read", () => {
  expect(() =>
    assertStartupConfig({
      COFORGE_IMAGE_DELIVERY_URL: "https://images-staging.coforge.cn",
      COFORGE_FILE_STORAGE: "oss",
      COFORGE_OSS_BUCKET: "coforge-files-staging",
      COFORGE_OSS_REGION: "oss-cn-beijing",
    }),
  ).toThrow(FileStorageConfigError);
});

test("refuses to boot when profile images are published on the signed attachment domain", () => {
  expect(() =>
    assertStartupConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn",
      COFORGE_FILE_DELIVERY_KEY: "primarykey",
      COFORGE_IMAGE_DELIVERY_URL: "https://files-staging.coforge.cn",
    }),
  ).toThrow(PublicImageDeliveryConfigError);
});
