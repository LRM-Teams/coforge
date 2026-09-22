import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WindowsWorkspaceInstance } from "../src/supervisor/windows-workspace-instance";
import type { WorkspaceInstanceConfig } from "../src/supervisor/workspace-instance";

async function config(): Promise<WorkspaceInstanceConfig & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), "coforge-windows-workspace-"));
  return {
    root,
    stateRoot: root,
    workspaceId: "workspace-a",
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: join(root, "workspaces", "a", "daemon.sock"),
    stateDirectory: join(root, "workspaces", "a"),
    unitDirectory: join(root, "windows-workspaces"),
    supervisorSocketPath: join(root, "daemon.sock"),
    daemonConnectionEndpoint: "ws://127.0.0.1:8000/connection/websocket",
  };
}

test("ensureStarted spawns __workspace-daemon once and reuses a live PID", async () => {
  const cfg = await config();
  const spawns: { command: string[]; env: Record<string, string> }[] = [];
  let alive = true;
  try {
    const instance = new WindowsWorkspaceInstance(
      cfg,
      async (input) => {
        spawns.push({ command: input.command, env: input.env });
        return { pid: 4242 };
      },
      () => alive,
    );
    expect(await instance.ensureStarted()).toBe(4242);
    expect(await instance.ensureStarted()).toBe(4242);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toEqual([
      "C:\\Coforge\\coforge-computer.exe",
      "__workspace-daemon",
      "--socket",
      cfg.socketPath,
      "--state-directory",
      cfg.stateDirectory,
    ]);
    expect(spawns[0]?.env.COFORGE_DAEMON_HOME).toBe(cfg.stateDirectory);
    expect(spawns[0]?.env.COFORGE_SUPERVISOR_SOCKET).toBe(cfg.supervisorSocketPath);
    expect(spawns[0]?.env.COFORGE_DAEMON_CONNECTION_ENDPOINT).toBe(
      "ws://127.0.0.1:8000/connection/websocket",
    );
    const first = await instance.identity();
    expect(first).toMatchObject({ mainPid: 4242, active: true });
    expect(first?.invocationId).toMatch(/^[0-9a-f]{32}$/);

    alive = false;
    expect(await instance.ensureStarted()).toBe(4242);
    expect(spawns).toHaveLength(2);
    const second = await instance.identity();
    expect(second?.invocationId).not.toBe(first?.invocationId);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("stop clears the durable instance record after signalling the child", async () => {
  const cfg = await config();
  const signals: number[] = [];
  try {
    const instance = new WindowsWorkspaceInstance(
      cfg,
      async () => ({ pid: 77 }),
      (pid) => {
        signals.push(pid);
        return signals.filter((value) => value === pid).length < 2;
      },
    );
    await instance.ensureStarted();
    await instance.stop();
    expect(await instance.identity()).toBeNull();
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});

test("identity key is stable for the state root and Workspace", async () => {
  const cfg = await config();
  try {
    const a = new WindowsWorkspaceInstance(cfg, async () => ({ pid: 1 }), () => false);
    const same = new WindowsWorkspaceInstance(cfg, async () => ({ pid: 1 }), () => false);
    const b = new WindowsWorkspaceInstance(
      { ...cfg, workspaceId: "workspace-b" },
      async () => ({ pid: 1 }),
      () => false,
    );
    expect(a.identityKey).toBe(same.identityKey);
    expect(a.identityKey).not.toBe(b.identityKey);
    expect(a.identityKey).toMatch(/^[0-9a-f]{24}$/);
  } finally {
    await rm(cfg.root, { recursive: true, force: true });
  }
});
