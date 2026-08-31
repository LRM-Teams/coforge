import { expect, test } from "bun:test";
import { NativeDaemonCredentialStore } from "../src/credentials/credential-store";

test("native Daemon Runtime credential store delegates to the OS secret store", async () => {
  const calls: unknown[] = [];
  const secrets = {
    async set(input: unknown) {
      calls.push(["set", input]);
    },
    async get(input: unknown) {
      calls.push(["get", input]);
      return "daemon-runtime-secret";
    },
    async delete(input: unknown) {
      calls.push(["delete", input]);
      return true;
    },
  };
  const store = new NativeDaemonCredentialStore(secrets);

  await store.save("workspace-a", "computer-a", "daemon-runtime-secret");
  await expect(store.load("workspace-a", "computer-a")).resolves.toBe("daemon-runtime-secret");
  await store.delete("workspace-a", "computer-a");

  expect(calls).toEqual([
    [
      "set",
      {
        service: "cn.coforge.daemon.daemon-runtime",
        name: "workspace-a:computer-a",
        value: "daemon-runtime-secret",
      },
    ],
    [
      "get",
      {
        service: "cn.coforge.daemon.daemon-runtime",
        name: "workspace-a:computer-a",
      },
    ],
    [
      "delete",
      {
        service: "cn.coforge.daemon.daemon-runtime",
        name: "workspace-a:computer-a",
      },
    ],
  ]);
});

test("native Daemon Runtime credential store preserves secret-store failures", async () => {
  const store = new NativeDaemonCredentialStore({
    set: async () => {
      throw new Error("secret service unavailable");
    },
    get: async () => null,
    delete: async () => true,
  });

  await expect(store.save("workspace-a", "computer-a", "secret")).rejects.toThrow(
    "secret service unavailable",
  );
});
