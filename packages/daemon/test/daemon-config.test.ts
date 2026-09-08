import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonConfigStore } from "../src/persistence/daemon-config";

test("daemon rejects a cross-environment configure request before applying it", () => {
  const store = new DaemonConfigStore("/unused", { serverHttpUrl: "https://coforge.cn" });
  expect(() =>
    store.bindToServer({
      computerId: "computer-a",
      workspaceId: "workspace-a",
      workspaceRoot: "/work",
      serverHttpUrl: "https://staging.coforge.cn",
    }),
  ).toThrow("does not match this daemon build");
});

test("daemon config stores one replaceable configuration without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-config-"));
  try {
    const store = new DaemonConfigStore(directory);
    const config = { computerId: "computer-a", workspaceId: "workspace-a", workspaceRoot: "/work" };
    await store.save(config);
    expect(await store.load()).toEqual(config);
    await store.save({ ...config, workspaceRoot: "/replacement" });
    expect(await store.load()).toEqual({ ...config, workspaceRoot: "/replacement" });
    expect(await Bun.file(join(directory, "config.json")).text()).not.toContain("token");
    await store.clear();
    expect(await store.load()).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon config persists its injected build server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-config-web-endpoint-"));
  try {
    const store = new DaemonConfigStore(directory, {
      serverHttpUrl: "https://coforge.example",
    });
    await store.save({
      computerId: "computer-a",
      workspaceId: "workspace-a",
      workspaceRoot: "/work",
    });

    expect(await store.load()).toEqual({
      computerId: "computer-a",
      workspaceId: "workspace-a",
      workspaceRoot: "/work",
      serverHttpUrl: "https://coforge.example",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon config rejects persisted credentials from another server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-config-server-mismatch-"));
  try {
    const stored = new DaemonConfigStore(directory);
    await stored.save({
      computerId: "computer-a",
      workspaceId: "workspace-a",
      workspaceRoot: "/work",
      serverHttpUrl: "https://old.coforge.example",
    });

    const production = new DaemonConfigStore(directory, {
      serverHttpUrl: "https://coforge.example",
    });
    expect(production.load()).rejects.toThrow("does not match this daemon build");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon config rejects legacy persisted credentials with no server identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-config-legacy-server-"));
  try {
    const stored = new DaemonConfigStore(directory);
    await stored.save({
      computerId: "computer-a",
      workspaceId: "workspace-a",
      workspaceRoot: "/work",
    });

    const production = new DaemonConfigStore(directory, {
      serverHttpUrl: "https://coforge.example",
    });
    expect(production.load()).rejects.toThrow("does not identify its server");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
