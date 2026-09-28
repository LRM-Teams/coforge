import { expect, test } from "bun:test";
import { join } from "node:path";
import { agentEnvironment, agentRuntimeContextEnvironment } from "#src/code-agent/environment";

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
  expect(environment.GIT_CONFIG_COUNT).toBe("5");
  expect(environment.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
  expect(environment.GIT_CONFIG_VALUE_0).toBe("");
  expect(environment.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
  expect(environment.GIT_CONFIG_VALUE_1).toBe("!coforge github credential");
  expect(environment.GIT_CONFIG_KEY_2).toBe("credential.https://github.com.useHttpPath");
  expect(environment.GIT_CONFIG_VALUE_2).toBe("true");
  expect(environment.GIT_CONFIG_KEY_3).toBe("url.https://github.com/.insteadOf");
  expect(environment.GIT_CONFIG_VALUE_3).toBe("git@github.com:");
  expect(environment.GIT_CONFIG_KEY_4).toBe("url.https://github.com/.insteadOf");
  expect(environment.GIT_CONFIG_VALUE_4).toBe("ssh://git@github.com/");
  expect(environment).not.toHaveProperty("agentId");
  expect(environment).not.toHaveProperty("AGENT_ID");
});

test("preserves inherited command-scope Git configuration before the GitHub helper", () => {
  const environment = agentEnvironment(undefined, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "/workspace",
  });

  expect(environment.GIT_CONFIG_COUNT).toBe("6");
  expect(environment.GIT_CONFIG_KEY_0).toBe("safe.directory");
  expect(environment.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
  expect(environment.GIT_CONFIG_KEY_3).toBe("credential.https://github.com.useHttpPath");
  expect(environment.GIT_CONFIG_KEY_5).toBe("url.https://github.com/.insteadOf");
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

test("agentRuntimeContextEnvironment exports only the known, non-empty runtime-context facts", () => {
  const environment = agentRuntimeContextEnvironment({
    agentId: "agent-123",
    agentWorkspaceDirectory: "/var/coforge/agents/agent-123",
    identity: {
      name: "scout",
      displayName: "Scout the Explorer",
      description: "Investigates open questions.",
      runtimeContext: {
        workspaceId: "ws-1",
        workspaceSlug: "acme",
        workspaceName: "Acme",
        computerId: "computer-1",
        computerName: "Frank's Mac",
        computerHostname: "franks-mac.local",
        computerOs: "macOS 27",
        computerVersion: "0.1.0-dev.36",
      },
    },
  });

  expect(environment).toEqual({
    COFORGE_CURRENT_AGENT_ID: "agent-123",
    COFORGE_CURRENT_AGENT_NAME: "scout",
    COFORGE_CURRENT_WORKSPACE_ID: "ws-1",
    COFORGE_CURRENT_WORKSPACE_SLUG: "acme",
    COFORGE_CURRENT_WORKSPACE_NAME: "Acme",
    COFORGE_CURRENT_COMPUTER_ID: "computer-1",
    COFORGE_CURRENT_COMPUTER_NAME: "Frank's Mac",
    COFORGE_CURRENT_COMPUTER_HOSTNAME: "franks-mac.local",
    COFORGE_CURRENT_COMPUTER_OS: "macOS 27",
    COFORGE_CURRENT_COMPUTER_VERSION: "0.1.0-dev.36",
    COFORGE_CURRENT_AGENT_WORKSPACE_PATH: "/var/coforge/agents/agent-123",
  });
  expect(environment).not.toHaveProperty("COFORGE_CURRENT_AGENT_DISPLAY_NAME");
  expect(environment).not.toHaveProperty("COFORGE_CURRENT_AGENT_DESCRIPTION");
});

test("agentRuntimeContextEnvironment omits a variable whenever its source value is unknown or blank", () => {
  const environment = agentRuntimeContextEnvironment({
    agentId: "agent-123",
    agentWorkspaceDirectory: "/var/coforge/agents/agent-123",
  });

  expect(environment).toEqual({
    COFORGE_CURRENT_AGENT_ID: "agent-123",
    COFORGE_CURRENT_AGENT_WORKSPACE_PATH: "/var/coforge/agents/agent-123",
  });
});

test("agentRuntimeContextEnvironment strips CR/LF/NUL so a value stays single-line", () => {
  const environment = agentRuntimeContextEnvironment({
    agentId: "agent-123",
    agentWorkspaceDirectory: "/var/coforge/agents/agent-123",
    identity: {
      name: "scout\r\nCOFORGE_CURRENT_COMPUTER_ID=spoofed",
      runtimeContext: { computerName: "line\0one\nline two" },
    },
  });

  expect(environment.COFORGE_CURRENT_AGENT_NAME).toBe("scoutCOFORGE_CURRENT_COMPUTER_ID=spoofed");
  expect(environment.COFORGE_CURRENT_COMPUTER_NAME).toBe("lineoneline two");
});

test("declared runtime-context values win over an inherited or user-configured impostor", () => {
  const environment = agentEnvironment(
    {
      COFORGE_CURRENT_AGENT_ID: "real-agent",
      COFORGE_CURRENT_COMPUTER_NAME: "Real Computer",
    },
    { COFORGE_CURRENT_AGENT_ID: "host-spoof", COFORGE_CURRENT_WORKSPACE_NAME: "host-spoof" },
    "linux",
    {
      envVars: {
        COFORGE_CURRENT_AGENT_ID: "user-spoof",
        COFORGE_CURRENT_COMPUTER_NAME: "user-spoof",
      },
      extraEnv: { COFORGE_CURRENT_AGENT_ID: "adapter-spoof" },
    },
  );

  expect(environment.COFORGE_CURRENT_AGENT_ID).toBe("real-agent");
  expect(environment.COFORGE_CURRENT_COMPUTER_NAME).toBe("Real Computer");
  // Not part of `declared` this call: cleared rather than left to an inherited impostor value.
  expect(environment.COFORGE_CURRENT_WORKSPACE_NAME).toBeUndefined();
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

test("a config-hook plan appends the CoForge commit trailer hook after the GitHub credential helper", () => {
  const environment = agentEnvironment(undefined, {}, "linux", {
    gitHooks: { kind: "config-hook" },
  });

  expect(environment.GIT_CONFIG_COUNT).toBe("7");
  expect(environment.GIT_CONFIG_KEY_5).toBe("hook.coforge-commit-trailers.event");
  expect(environment.GIT_CONFIG_VALUE_5).toBe("prepare-commit-msg");
  expect(environment.GIT_CONFIG_KEY_6).toBe("hook.coforge-commit-trailers.command");
  expect(environment.GIT_CONFIG_VALUE_6).toBe(
    `sh -c 'coforge git prepare-commit-msg "$@" || true' coforge-commit-trailers`,
  );
  expect(environment.COFORGE_GIT_CONFIG_BASE_COUNT).toBeUndefined();
});

test("a hooks-path plan points core.hooksPath at the shim directory and carries the pre-injection GIT_CONFIG_COUNT", () => {
  const environment = agentEnvironment(
    undefined,
    { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/workspace" },
    "linux",
    { gitHooks: { kind: "hooks-path", hooksDir: "/var/coforge/daemon/git-hook-shims/abc" } },
  );

  expect(environment.GIT_CONFIG_COUNT).toBe("7");
  expect(environment.GIT_CONFIG_KEY_6).toBe("core.hooksPath");
  expect(environment.GIT_CONFIG_VALUE_6).toBe("/var/coforge/daemon/git-hook-shims/abc");
  // The base count is the inherited count before this function's own entries - the GitHub
  // credential helper included - so the shim can strip them all and recover the real hooks path.
  expect(environment.COFORGE_GIT_CONFIG_BASE_COUNT).toBe("1");
});

test("an Agent's own tools cannot spoof COFORGE_GIT_CONFIG_BASE_COUNT through inherited or user-configured values", () => {
  const environment = agentEnvironment(undefined, { COFORGE_GIT_CONFIG_BASE_COUNT: "0" }, "linux", {
    envVars: { COFORGE_GIT_CONFIG_BASE_COUNT: "0" },
  });

  expect(environment.COFORGE_GIT_CONFIG_BASE_COUNT).toBeUndefined();
});
