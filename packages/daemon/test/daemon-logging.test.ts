import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daemonLogPath, prepareDaemonLogFile } from "../src/platform/daemon-log-file";

test.each(["daemon", "coordinator"])(
  "%s writes child-category diagnostics with process metadata",
  async (role) => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-logs-"));
    const socketPath = join(directory, "daemon.sock");
    const child = spawnDaemon(socketPath, directory, role);
    try {
      await waitFor(() => pathExists(socketPath));
      await sendInvalidFrame(socketPath);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);

      const output = await readFile(daemonLogPath(directory), "utf8");
      const records = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown> & { logger: string });
      const record = records.find(({ logger }) => logger === "coforge.daemon.local-rpc");
      expect(record).toMatchObject({
        service: "coforge-daemon",
        process_role: role,
        pid: child.pid,
        event: "daemon.local_rpc.failed",
        outcome: "error",
      });
      expect(record?.version).toEqual(expect.any(String));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("Daemon refuses a symlinked log root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-logs-"));
  const target = await mkdtemp(join(tmpdir(), "coforge-daemon-log-target-"));
  try {
    const linkedRoot = join(directory, "linked-root");
    await symlink(target, linkedRoot);
    const child = spawnDaemon(join(directory, "daemon.sock"), linkedRoot);
    expect(await child.exited).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "Daemon tightens permissions on an existing rotated log",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-logs-"));
    try {
      const rotated = `${daemonLogPath(directory)}.1`;
      await mkdir(join(directory, "logs", "daemon"), { recursive: true });
      await writeFile(rotated, "old log\n", { mode: 0o644 });
      await prepareDaemonLogFile(directory);
      expect((await stat(rotated)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Daemon refuses a symlink in the log root path",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-logs-"));
    const target = await mkdtemp(join(tmpdir(), "coforge-daemon-log-target-"));
    try {
      await mkdir(join(target, "workspace"));
      const linkedParent = join(directory, "linked-parent");
      await symlink(target, linkedParent);
      const stateDirectory = join(linkedParent, "workspace");
      const child = spawnDaemon(join(directory, "daemon.sock"), stateDirectory);
      expect(await child.exited).not.toBe(0);
      expect(await Bun.file(daemonLogPath(join(target, "workspace"))).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Daemon refuses a symlinked active log file",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-logs-"));
    const target = await mkdtemp(join(tmpdir(), "coforge-daemon-log-target-"));
    try {
      const logDirectory = join(directory, "logs", "daemon");
      await mkdir(logDirectory, { recursive: true });
      await symlink(join(target, "outside.jsonl"), daemonLogPath(directory));
      const child = spawnDaemon(join(directory, "daemon.sock"), directory);
      expect(await child.exited).not.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  },
);

function spawnDaemon(socketPath: string, stateDirectory: string, role = "daemon"): Bun.Subprocess {
  return Bun.spawn(
    [
      process.execPath,
      join(
        import.meta.dir,
        role === "coordinator" ? "fixtures/logging-supervisor.ts" : "../index.ts",
      ),
      "--socket",
      socketPath,
      "--state-directory",
      stateDirectory,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
}

async function sendInvalidFrame(socketPath: string): Promise<void> {
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data() {
        closed.reject(new Error("daemon unexpectedly returned a response"));
      },
      close() {
        closed.resolve();
      },
      error(_socket, error) {
        closed.reject(error);
      },
    },
  });
  socket.write(new Uint8Array([0, 0, 0, 1, 255]));
  await closed.promise;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Daemon startup");
    await Bun.sleep(10);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
