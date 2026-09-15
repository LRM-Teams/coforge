import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileBindingStore } from "../src/supervisor/binding-store";
import type { ManagedBinding } from "../src/supervisor/machine-supervisor";

test("binding registry reopens restart progress and terminal receipts from private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-bindings-"));
  const bindings: ManagedBinding[] = [
    {
      workspaceId: "a",
      computerId: "c",
      workspaceRoot: "/a",
      enabled: true,
      restart: { requestId: "r", phase: "starting", previousInstanceId: "old" },
      restartResults: [{ requestId: "previous", status: "completed", instanceId: "old" }],
    },
  ];
  try {
    expect(await new FileBindingStore(root).load()).toEqual([]);
    await new FileBindingStore(root).save(bindings);
    expect(await new FileBindingStore(root).load()).toEqual(bindings);
    expect((await stat(join(root, "bindings.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["bindings.json"]);
    for (const restart of [
      {},
      { requestId: "r", phase: "garbage", previousInstanceId: null },
      { requestId: "r", phase: "starting", previousInstanceId: 42 },
    ]) {
      await Bun.write(join(root, "bindings.json"), JSON.stringify([{ ...bindings[0], restart }]));
      await expect(new FileBindingStore(root).load()).rejects.toThrow("invalid binding registry");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Coordinator registry rejects missing and mismatched environments without rewriting bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-binding-environment-"));
  const store = new FileBindingStore(root, "https://coforge.cn");
  try {
    for (const serverHttpUrl of [undefined, "https://staging.coforge.cn"]) {
      const bindings = [
        { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true, serverHttpUrl },
      ];
      const content = JSON.stringify(bindings);
      await Bun.write(join(root, "bindings.json"), content);
      await expect(store.load()).rejects.toThrow();
      await expect(store.save(bindings)).rejects.toThrow();
      expect(await Bun.file(join(root, "bindings.json")).text()).toBe(content);
    }
    await store.save([
      {
        workspaceId: "a",
        computerId: "c",
        workspaceRoot: "/a",
        enabled: false,
        serverHttpUrl: "https://coforge.cn",
      },
    ]);
    expect((await store.load())[0]?.enabled).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding registry fails closed on malformed upgrade requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-binding-upgrade-"));
  const binding = {
    workspaceId: "a",
    computerId: "c",
    workspaceRoot: "/a",
    enabled: true,
  };
  try {
    for (const upgradeRequests of [
      [{ requestId: "r" }],
      [{ requestId: "r", expectedVersion: "" }],
      [
        { requestId: "r", expectedVersion: "1.0.0" },
        { requestId: "r", expectedVersion: "1.0.0" },
      ],
    ]) {
      await Bun.write(
        join(root, "bindings.json"),
        JSON.stringify([{ ...binding, upgradeRequests }]),
      );
      await expect(new FileBindingStore(root).load()).rejects.toThrow(
        "invalid binding registry upgrade request",
      );
    }
    const valid = [{ ...binding, upgradeRequests: [{ requestId: "r", expectedVersion: "1.0.0" }] }];
    await new FileBindingStore(root).save(valid);
    expect(await new FileBindingStore(root).load()).toEqual(valid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
