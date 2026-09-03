import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computerLogPath, configureComputerLogger } from "../src/logging/computer-logger";

test("Computer logger writes structured JSONL and redacts credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-computer-logs-"));
  const logging = await configureComputerLogger({
    dataDirectory: directory,
    version: "0.1.0",
    pid: 42,
  });
  try {
    logging.logger.info("Computer command completed", {
      event: "computer:started",
      token: "access-secret",
    });
  } finally {
    await logging.close();
  }

  try {
    const output = await readFile(computerLogPath(directory), "utf8");
    const record = JSON.parse(output.trim()) as {
      logger: string;
      properties: Record<string, unknown>;
    };
    expect(record.logger).toBe("coforge.computer");
    expect(record.properties.event).toBe("computer:started");
    expect(output).not.toContain("access-secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
