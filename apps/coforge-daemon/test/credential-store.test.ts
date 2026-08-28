import { expect, test } from "bun:test";
import { NativeWorkspaceWorkerCredentialStore } from "../src/workspace-worker/credential-store";

test("native Workspace Worker credential store delegates to the OS secret store", async () => {
  const calls: unknown[] = [];
  const secrets = {
    async set(input: unknown) {
      calls.push(["set", input]);
    },
    async get(input: unknown) {
      calls.push(["get", input]);
      return "workspace-worker-secret";
    },
    async delete(input: unknown) {
      calls.push(["delete", input]);
      return true;
    },
  };
  const store = new NativeWorkspaceWorkerCredentialStore(secrets);

  await store.save("connection-a", "workspace-worker-secret");
  await expect(store.load("connection-a")).resolves.toBe("workspace-worker-secret");
  await store.delete("connection-a");

  expect(calls).toEqual([
    [
      "set",
      {
        service: "cn.coforge.daemon.workspace-worker",
        name: "connection-a",
        value: "workspace-worker-secret",
      },
    ],
    [
      "get",
      {
        service: "cn.coforge.daemon.workspace-worker",
        name: "connection-a",
      },
    ],
    [
      "delete",
      {
        service: "cn.coforge.daemon.workspace-worker",
        name: "connection-a",
      },
    ],
  ]);
});

test("native Workspace Worker credential store preserves secret-store failures", async () => {
  const store = new NativeWorkspaceWorkerCredentialStore({
    set: async () => {
      throw new Error("secret service unavailable");
    },
    get: async () => null,
    delete: async () => true,
  });

  await expect(store.save("connection-a", "secret")).rejects.toThrow("secret service unavailable");
});
