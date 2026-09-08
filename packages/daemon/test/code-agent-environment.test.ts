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

test("Windows service discovery and Agent launch use the same user executable paths", () => {
  const environment = agentEnvironment(
    undefined,
    {
      PATH: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\Frank",
      APPDATA: "C:\\Users\\Frank\\AppData\\Roaming",
    },
    "win32",
  );

  expect(environment.USERPROFILE).toBe("C:\\Users\\Frank");
  expect(environment.APPDATA).toBe("C:\\Users\\Frank\\AppData\\Roaming");
  expect(environment.PATH?.split(";")).toContain("C:\\Users\\Frank\\AppData\\Roaming\\npm");
  expect(environment.PATH?.split(";")).toContain("C:\\Users\\Frank\\.local\\bin");
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
