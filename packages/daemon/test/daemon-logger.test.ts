import { expect, test } from "bun:test";

import { configureDaemonLogger } from "../src/logging/daemon-logger";

test("Daemon uses structured stderr diagnostics with field redaction", async () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => lines.push(values.join(" "));

  try {
    const logging = await configureDaemonLogger({ version: "test", pid: 123 });
    logging.logger.info("Checked messages", {
      event: "agent.message.checked",
      request_id: "request-1",
      agent_id: "agent-1",
      displayed_count: 1,
      body: "private message",
      authorization: "Bearer private",
    });
    await logging.close();
  } finally {
    console.error = originalError;
  }

  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!);
  expect(record).toMatchObject({
    level: "INFO",
    service: "coforge-daemon",
    version: "test",
    process_role: "daemon",
    pid: 123,
    event: "agent.message.checked",
    request_id: "request-1",
    agent_id: "agent-1",
    displayed_count: 1,
  });
  expect(record.body).toBeUndefined();
  expect(record.authorization).toBeUndefined();
  expect(lines[0]).not.toContain("private message");
  expect(lines[0]).not.toContain("Bearer private");
});
