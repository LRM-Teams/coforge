import { expect, test } from "bun:test";

import { FileDeliveryConfigError } from "../src/server/files/file-delivery.server";
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
