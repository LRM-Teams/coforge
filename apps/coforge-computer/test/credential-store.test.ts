import { expect, test } from "bun:test";

import { NativeCredentialStore } from "../src/credential-store";

test("credential store delegates the complete credential to the operating system keyring", async () => {
  const writes: Array<{ service: string; name: string; value: string }> = [];
  const store = new NativeCredentialStore({
    async set(options) {
      writes.push({ service: options.service, name: options.name, value: options.value });
    },
  });

  await store.save("https://coforge.example", {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    tokenType: "Bearer",
    expiresInSeconds: 3600,
  });

  expect(writes).toEqual([
    {
      service: "cn.coforge.computer",
      name: "https://coforge.example",
      value: JSON.stringify({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        tokenType: "Bearer",
        expiresInSeconds: 3600,
      }),
    },
  ]);
});

test("credential store reports an actionable stable failure", async () => {
  const store = new NativeCredentialStore({
    async set() {
      throw new Error("org.freedesktop.secrets unavailable");
    },
  });

  await expect(
    store.save("https://coforge.example", {
      accessToken: "access-secret",
      tokenType: "Bearer",
    }),
  ).rejects.toMatchObject({ code: "AUTH_CREDENTIAL_STORE_UNAVAILABLE" });
});
