import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileBindingStore } from "../src/supervisor/binding-store";
import type { ManagedBinding } from "../src/supervisor/machine-supervisor";

test("binding registry save completes on this platform without requiring directory fsync", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-bindings-platform-"));
  try {
    const store = new FileBindingStore(root);
    await store.save([
      { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true },
    ]);
    expect(await store.load()).toEqual([
      { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    if (process.platform !== "win32")
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
    expect(await new FileBindingStore(root, undefined, () => 7).load()).toEqual([
      {
        ...binding,
        upgradeOperations: [
          { requestId: "r", expectedVersion: "1.0.0", state: "pending", requestedAt: 7 },
        ],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding registry validates upgrade operation records and their terminal receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-binding-operation-"));
  const binding = { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true };
  try {
    for (const upgradeOperations of [
      [{ requestId: "r", expectedVersion: "1.0.0", requestedAt: 1 }],
      [{ requestId: "r", expectedVersion: "1.0.0", state: "running", requestedAt: 1 }],
      [{ requestId: "r", expectedVersion: "", state: "pending", requestedAt: 1 }],
      // An operation with no age of its own cannot be aged out, so it fails closed.
      [{ requestId: "r", expectedVersion: "1.0.0", state: "pending" }],
      [{ requestId: "r", expectedVersion: "1.0.0", state: "pending", requestedAt: -1 }],
      [
        { requestId: "r", expectedVersion: "1.0.0", state: "pending", requestedAt: 1 },
        { requestId: "r", expectedVersion: "1.0.0", state: "pending", requestedAt: 1 },
      ],
      [
        {
          requestId: "r",
          expectedVersion: "1.0.0",
          state: "succeeded",
          requestedAt: 1,
          terminal: { at: "now" },
        },
      ],
      [{ requestId: "r", expectedVersion: "1.0.0", state: "failed", requestedAt: 1 }],
      [
        { requestId: "r", expectedVersion: "1.0.0", state: "pending", requestedAt: 1 },
        { requestId: "s", expectedVersion: "1.0.0", state: "pending", requestedAt: 1 },
      ],
    ]) {
      await Bun.write(
        join(root, "bindings.json"),
        JSON.stringify([{ ...binding, upgradeOperations }]),
      );
      await expect(new FileBindingStore(root).load()).rejects.toThrow(
        "invalid binding registry upgrade operation",
      );
    }
    const valid = [
      {
        ...binding,
        upgradeOperations: [
          {
            requestId: "r",
            expectedVersion: "1.0.0",
            state: "acknowledged" as const,
            requestedAt: 1,
          },
          {
            requestId: "s",
            expectedVersion: "1.1.0",
            state: "failed" as const,
            requestedAt: 2,
            terminal: { error: "candidate failed", at: 3 },
          },
          { requestId: "t", expectedVersion: "1.2.0", state: "pending" as const, requestedAt: 4 },
        ],
      },
    ];
    await new FileBindingStore(root).save(valid);
    expect(await new FileBindingStore(root).load()).toEqual(valid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy upgrade requests reopen as pending operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-binding-migration-"));
  try {
    await Bun.write(
      join(root, "bindings.json"),
      JSON.stringify([
        {
          workspaceId: "a",
          computerId: "c",
          workspaceRoot: "/a",
          enabled: true,
          upgradeRequests: [
            { requestId: "old", expectedVersion: "0.1.0-dev.28" },
            { requestId: "older", expectedVersion: "0.1.0-dev.27" },
          ],
        },
      ]),
    );
    // A legacy entry carries no age, so the migration itself starts its expiry clock.
    const [migrated] = await new FileBindingStore(root, undefined, () => 4_200).load();
    expect(migrated?.upgradeRequests).toBeUndefined();
    expect(migrated?.upgradeOperations).toEqual([
      { requestId: "old", expectedVersion: "0.1.0-dev.28", state: "pending", requestedAt: 4_200 },
      { requestId: "older", expectedVersion: "0.1.0-dev.27", state: "pending", requestedAt: 4_200 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
