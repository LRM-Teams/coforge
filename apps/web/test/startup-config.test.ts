import { expect, test } from "bun:test";

import { FileDeliveryConfigError } from "@/server/files/file-delivery.server";
import { FileStorageConfigError } from "@/server/files/file-storage.server";
import { PublicImageDeliveryConfigError } from "@/server/files/public-image-delivery.server";
import { assertStartupConfig } from "@/server/startup-config.server";

test("boots without CDN delivery when it is not configured", async () => {
  await expect(assertStartupConfig({})).resolves.toBeUndefined();
});

test("refuses to boot when the delivery URL is set but its signing key is missing", async () => {
  await expect(
    assertStartupConfig({ COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn" }),
  ).rejects.toThrow(FileDeliveryConfigError);
});

test("refuses to boot when the signing key file cannot be read", async () => {
  await expect(
    assertStartupConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn",
      COFORGE_FILE_DELIVERY_KEY_FILE: "/nonexistent/coforge_file_delivery_key",
    }),
  ).rejects.toThrow(FileDeliveryConfigError);
});

test("refuses to boot when public image URLs would point at a bucket the image domain cannot read", async () => {
  await expect(
    assertStartupConfig({
      COFORGE_IMAGE_DELIVERY_URL: "https://images-staging.coforge.cn",
      COFORGE_FILE_STORAGE: "oss",
      COFORGE_OSS_BUCKET: "coforge-files-staging",
      COFORGE_OSS_REGION: "oss-cn-beijing",
    }),
  ).rejects.toThrow(FileStorageConfigError);
});

test("refuses to boot when profile images are published on the signed attachment domain", async () => {
  await expect(
    assertStartupConfig({
      COFORGE_FILE_DELIVERY_URL: "https://files-staging.coforge.cn",
      COFORGE_FILE_DELIVERY_KEY: "primarykey",
      COFORGE_IMAGE_DELIVERY_URL: "https://files-staging.coforge.cn",
    }),
  ).rejects.toThrow(PublicImageDeliveryConfigError);
});
