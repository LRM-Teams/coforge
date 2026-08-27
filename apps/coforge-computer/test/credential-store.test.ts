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

test("credential store loads the credential for the current server", async () => {
  const reads: Array<{ service: string; name: string }> = [];
  const store = new NativeCredentialStore({
    async set() {},
    async get(options) {
      reads.push(options);
      return JSON.stringify({ accessToken: "access-secret", tokenType: "Bearer" });
    },
  });

  await expect(store.load("https://coforge.example")).resolves.toEqual({
    accessToken: "access-secret",
    tokenType: "Bearer",
  });
  expect(reads).toEqual([{ service: "cn.coforge.computer", name: "https://coforge.example" }]);
});

test("credential store returns null when the current server has no login", async () => {
  const store = new NativeCredentialStore({
    async set() {},
    async get() {
      return null;
    },
  });

  await expect(store.load("https://coforge.example")).resolves.toBeNull();
});
