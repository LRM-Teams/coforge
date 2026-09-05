import { expect, test } from "bun:test";
import { join } from "node:path";
import { agentEnvironment } from "../src/code-agent/environment";

test("makes the Agent-facing coforge binary available without Agent identity", () => {
  const environment = agentEnvironment({ AGENT_SECRET: "declared" });

  expect(environment.PATH?.split(":")).toContain(join(process.execPath, ".."));
  expect(environment).not.toHaveProperty("agentId");
  expect(environment).not.toHaveProperty("AGENT_ID");
});

test("installed version directory wins over an ambient or declared coforge command", () => {
  expect(agentEnvironment({ PATH: "/other/bin" }).PATH?.split(":")[0]).toBe(
    join(process.execPath, ".."),
  );
});

test("source development resolves the CLI without a separately compiled daemon CLI", () => {
  const result = Bun.spawnSync(["coforge", "message", "check"], {
    cwd: "/tmp",
    env: agentEnvironment(undefined),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("coforge agent context is not configured");
});
