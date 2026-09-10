import { expect, test } from "bun:test";
import { join } from "node:path";
import { agentEnvironment } from "../src/code-agent/environment";

test("inherits local host variables and overlays custom, adapter, then system values without mutating the host", () => {
  const inherited = {
    HTTP_PROXY: "http://proxy.example:8080",
    https_proxy: "http://secure.example:8081",
    OPENAI_API_KEY: "host-provider-key",
    CUSTOM_HOST_SETTING: "host",
    NO_PROXY: "example.com,LOCALHOST",
    no_proxy: "internal.example,example.com",
    SELECTED: "host",
    COFORGE_AGENT_CONTEXT: "stale-context",
  };
  const env = agentEnvironment({ SELECTED: "system" }, inherited, "linux", {
    envVars: { SELECTED: "custom", CUSTOM_HOST_SETTING: "custom", EMPTY: "" },
    extraEnv: { SELECTED: "adapter", NO_COLOR: "1" },
  });
  expect(env.HTTP_PROXY).toBe(inherited.HTTP_PROXY);
  expect(env.https_proxy).toBe(inherited.https_proxy);
  expect(env.OPENAI_API_KEY).toBe("host-provider-key");
  expect(env.CUSTOM_HOST_SETTING).toBe("custom");
  expect(env.SELECTED).toBe("system");
  expect(env.NO_COLOR).toBe("1");
  expect(env.EMPTY).toBe("");
  expect(env.NO_PROXY).toBe("127.0.0.1,localhost,example.com,internal.example");
  expect(env.no_proxy).toBe(env.NO_PROXY);
  expect(env.COFORGE_AGENT_CONTEXT).toBeUndefined();
  expect(inherited.CUSTOM_HOST_SETTING).toBe("host");
  expect(inherited.NO_PROXY).toBe("example.com,LOCALHOST");
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
