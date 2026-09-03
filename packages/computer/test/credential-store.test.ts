import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileCredentialStore } from "../src/credential-store";

test("credential store writes a server credential with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-credential-"));
  const store = new FileCredentialStore(directory);

  await store.save("https://coforge.example", {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    tokenType: "Bearer",
    expiresInSeconds: 3600,
  });

  const path = join(directory, "coforge.example.json");
  expect(JSON.parse(await readFile(path, "utf8")).accessToken).toBe("access-secret");
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("credential store uses an explicit credential directory over Computer home", async () => {
  const explicit = await mkdtemp(join(tmpdir(), "coforge-credential-"));
  const home = await mkdtemp(join(tmpdir(), "coforge-home-"));
  const store = new FileCredentialStore(explicit);
  await store.save("https://coforge.example", { accessToken: "secret", tokenType: "Bearer" });
  expect(await Bun.file(join(explicit, "coforge.example.json")).exists()).toBe(true);
  expect(await Bun.file(join(home, "credentials", "coforge.example.json")).exists()).toBe(false);
});

test("credential store reports an actionable stable failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-credential-"));
  await writeFile(join(directory, "file"), "not a directory");
  const store = new FileCredentialStore(join(directory, "file"));

  await expect(
    store.save("https://coforge.example", {
      accessToken: "access-secret",
      tokenType: "Bearer",
    }),
  ).rejects.toMatchObject({ code: "AUTH_CREDENTIAL_STORE_UNAVAILABLE" });
});

test("credential store loads the credential for the current server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-credential-"));
  const store = new FileCredentialStore(directory);
  await store.save("https://coforge.example", {
    accessToken: "access-secret",
    tokenType: "Bearer",
  });

  await expect(store.load("https://coforge.example")).resolves.toEqual({
    accessToken: "access-secret",
    tokenType: "Bearer",
  });
});

test("credential store returns null when the current server has no login", async () => {
  const store = new FileCredentialStore(await mkdtemp(join(tmpdir(), "coforge-credential-")));

  await expect(store.load("https://coforge.example")).resolves.toBeNull();
});
