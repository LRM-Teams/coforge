import { expect, test } from "bun:test";
import { join } from "node:path";
import { agentEnvironment } from "../src/code-agent/environment";

test("inherits host proxy settings without inheriting unrelated secrets", () => {
  const proxy = {
    HTTP_PROXY: "http://localhost:7893",
    HTTPS_PROXY: "http://localhost:7893",
    ALL_PROXY: "socks5://localhost:7893",
    NO_PROXY: "localhost,127.0.0.1",
    http_proxy: "http://localhost:7894",
    https_proxy: "http://localhost:7894",
    all_proxy: "socks5://localhost:7894",
    no_proxy: "localhost,127.0.0.1,internal.example",
  };
  const environment = agentEnvironment(undefined, {
    ...proxy,
    DATABASE_PASSWORD: "must-not-be-inherited",
  });

  expect(environment).toMatchObject(proxy);
  expect(environment).not.toHaveProperty("DATABASE_PASSWORD");
});

test("makes the Agent-facing coforge binary available without Agent identity", () => {
  const environment = agentEnvironment({ AGENT_SECRET: "declared" });

  expect(environment.PATH?.split(":")).toContain(join(process.execPath, ".."));
  expect(environment).not.toHaveProperty("agentId");
  expect(environment).not.toHaveProperty("AGENT_ID");
});

test("explicit Agent proxy settings override inherited values including empty values", () => {
  const environment = agentEnvironment(
    { HTTPS_PROXY: "http://localhost:8000", https_proxy: "", NO_PROXY: "*" },
    {
      HTTPS_PROXY: "http://localhost:7893",
      https_proxy: "http://localhost:7893",
      NO_PROXY: "localhost",
    },
  );

  expect(environment).toMatchObject({
    HTTPS_PROXY: "http://localhost:8000",
    https_proxy: "",
    NO_PROXY: "*",
  });
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
