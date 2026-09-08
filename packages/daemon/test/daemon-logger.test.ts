import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDaemonLogger, daemonLogPath } from "../src/logging/daemon-logger";

test("Daemon writes structured diagnostics to disk with field redaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-logs-"));
  try {
    const logging = await configureDaemonLogger({
      dataDirectory: directory,
      version: "test",
      pid: 123,
    });
    logging.logger.info("Checked messages", {
      event: "agent.message.checked",
      request_id: "request-1",
      agent_id: "agent-1",
      displayed_count: 1,
      body: "private message",
      authorization: "Bearer private",
    });
    await logging.close();

    const output = await readFile(daemonLogPath(directory), "utf8");
    const record = JSON.parse(output.trim()) as {
      logger: string;
      properties: Record<string, unknown>;
    };
    expect(record.logger).toBe("coforge.daemon");
    expect(record.properties).toMatchObject({
      service: "coforge-daemon",
      version: "test",
      process_role: "daemon",
      pid: 123,
      event: "agent.message.checked",
      request_id: "request-1",
      agent_id: "agent-1",
      displayed_count: 1,
    });
    expect(output).not.toContain("private message");
    expect(output).not.toContain("Bearer private");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("Daemon refuses a symlinked log root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-logs-"));
  const target = await mkdtemp(join(tmpdir(), "coforge-daemon-log-target-"));
  try {
    const linkedRoot = join(directory, "linked-root");
    await symlink(target, linkedRoot);
    await expect(
      configureDaemonLogger({ dataDirectory: linkedRoot, version: "test" }),
    ).rejects.toThrow("Daemon log path must not contain symbolic links");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "Daemon refuses a symlink in the log root path",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-logs-"));
    const target = await mkdtemp(join(tmpdir(), "coforge-daemon-log-target-"));
    try {
      await mkdir(join(target, "workspace"));
      const linkedParent = join(directory, "linked-parent");
      await symlink(target, linkedParent);
      await expect(
        configureDaemonLogger({
          dataDirectory: join(linkedParent, "workspace"),
          version: "test",
        }),
      ).rejects.toThrow("Daemon log path must not contain symbolic links");
      expect(
        await Bun.file(join(target, "workspace", "logs", "daemon", "daemon.jsonl")).exists(),
      ).toBe(false);
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
      await expect(
        configureDaemonLogger({ dataDirectory: directory, version: "test" }),
      ).rejects.toThrow("Daemon log path must not contain symbolic links");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  },
);
