import { afterEach, expect, test } from "bun:test";
import { FileDaemonCredentialStore } from "#src/credentials/credential-store";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("Daemon credential store persists a private API key file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-credentials-"));
  directories.push(directory);
  const store = new FileDaemonCredentialStore(directory);

  await store.save("workspace-a", "computer-a", "daemon-runtime-secret");
  await expect(store.load("workspace-a", "computer-a")).resolves.toBe("daemon-runtime-secret");
  const path = join(directory, "credentials", "workspace-a-computer-a.api-key");
  await expect(readFile(path, "utf8")).resolves.toBe("daemon-runtime-secret\n");
  await expect(stat(path)).resolves.toMatchObject({ mode: 0o100600 });
  await store.delete("workspace-a", "computer-a");
  await expect(store.load("workspace-a", "computer-a")).resolves.toBeNull();
});
