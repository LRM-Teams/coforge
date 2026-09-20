import { expect, test } from "bun:test";

import { FileStorageConfigError } from "../src/server/files/file-storage.server";
import { readPublicImageStorageConfig } from "../src/server/files/public-image-storage.server";

const ossEnv = {
  COFORGE_FILE_STORAGE: "oss",
  COFORGE_OSS_BUCKET: "coforge-files-staging",
  COFORGE_OSS_REGION: "oss-cn-hangzhou",
};

test("local storage keeps profile images beside the private files", () => {
  expect(readPublicImageStorageConfig({ COFORGE_FILE_STORAGE: "local" })).toBeNull();
});

test("an OSS deployment without an image bucket keeps profile images in the private bucket", () => {
  expect(readPublicImageStorageConfig(ossEnv)).toBeNull();
});

test("a configured image bucket reuses the private store's region and credentials", () => {
  expect(
    readPublicImageStorageConfig({
      ...ossEnv,
      COFORGE_IMAGE_OSS_BUCKET: "coforge-images-staging",
      COFORGE_OSS_INTERNAL: "1",
    }),
  ).toEqual({
    kind: "oss",
    bucket: "coforge-images-staging",
    region: "cn-hangzhou",
    endpoint: null,
    internal: true,
    accessKey: null,
  });
});

test("the image bucket must not be the private files bucket", () => {
  expect(() =>
    readPublicImageStorageConfig({
      ...ossEnv,
      COFORGE_IMAGE_OSS_BUCKET: "coforge-files-staging",
    }),
  ).toThrow(FileStorageConfigError);
});

test("publishing image URLs from a bucket the image domain cannot read is refused", () => {
  expect(() =>
    readPublicImageStorageConfig({
      ...ossEnv,
      COFORGE_IMAGE_DELIVERY_URL: "https://images-staging.coforge.cn",
    }),
  ).toThrow(FileStorageConfigError);
});
