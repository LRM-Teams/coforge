import { expect, test } from "bun:test";
import pc from "picocolors";

import { ComputerLogin, type CredentialStore, type DeviceAuthorizationClient } from "../src/login";

test("login completes the device-code flow and persists the credential", async () => {
  const events: string[] = [];
  const client: DeviceAuthorizationClient = {
    async authorize() {
      events.push("authorize");
      return {
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example/activate",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      };
    },
    async pollToken(deviceCode) {
      events.push(`poll:${deviceCode}`);
      return {
        status: "authorized",
        credential: {
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          tokenType: "Bearer",
          expiresInSeconds: 3600,
        },
      };
    },
    async listWorkspaces(credential) {
      events.push(`workspaces:${credential.accessToken}`);
      return [
        { id: "ws_01", slug: "alpha", name: "Alpha Team" },
        { id: "ws_02", slug: "beta", name: "Beta Team" },
      ];
    },
  };
  const store: CredentialStore = {
    async save(serverUrl, credential) {
      events.push(`save:${serverUrl}:${credential.accessToken}`);
    },
  };
  const output: string[] = [];
  const progress: string[] = [];

  const result = await new ComputerLogin({
    client,
    store,
    writeLine: (line) => output.push(line),
    writeProgressLine: (line) => progress.push(line),
    sleep: async () => undefined,
    colors: pc.createColors(false),
  }).run({ serverUrl: "https://coforge.example", json: false });

  expect(result).toEqual({
    serverUrl: "https://coforge.example",
    workspaces: [
      { id: "ws_01", slug: "alpha", name: "Alpha Team" },
      { id: "ws_02", slug: "beta", name: "Beta Team" },
    ],
  });
  expect(output).toEqual([
    "CoForge Computer login",
    "Server:      https://coforge.example",
    "",
    "To sign in:",
    "Verify at:   https://auth.example/activate",
    "User code:   ABCD-EFGH",
    "",
    "Workspaces:  2",
    "  - Alpha Team (alpha)",
    "  - Beta Team (beta)",
    "Result:      Login complete. No Workspace binding was created.",
  ]);
  expect(progress).toEqual(["Waiting for authorization…"]);
  expect(events).toEqual([
    "authorize",
    "poll:device-secret",
    "save:https://coforge.example:access-secret",
    "workspaces:access-secret",
  ]);
});

test("JSON login writes exactly one stable stdout object without secrets", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await new ComputerLogin({
    client: {
      async authorize() {
        return {
          deviceCode: "device-secret",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.example/activate",
          expiresInSeconds: 600,
          intervalSeconds: 5,
        };
      },
      async pollToken() {
        return {
          status: "authorized",
          credential: { accessToken: "access-secret", tokenType: "Bearer" },
        } as const;
      },
      async listWorkspaces() {
        return [{ id: "ws_01", slug: "alpha", name: "Alpha Team" }];
      },
    },
    store: { async save() {} },
    writeLine: (line) => stdout.push(line),
    writeProgressLine: (line) => stderr.push(line),
    sleep: async () => undefined,
    colors: pc.createColors(false),
  }).run({ serverUrl: "https://coforge.example", json: true });

  expect(result.workspaces).toHaveLength(1);
  expect(stdout).toHaveLength(1);
  expect(JSON.parse(stdout[0]!)).toEqual({
    ok: true,
    server_url: "https://coforge.example",
    workspaces: [{ id: "ws_01", slug: "alpha", name: "Alpha Team" }],
    binding_created: false,
    daemon_started: false,
  });
  expect(stdout.join("\n")).not.toContain("access-secret");
  expect(stdout.join("\n")).not.toContain("device-secret");
  expect(stderr).toContain("Waiting for authorization…");
});

test("human login strips terminal controls from Workspace labels while JSON preserves data", async () => {
  const workspace = {
    id: "ws_01",
    slug: "alpha\u001b[31mPWN",
    name: "Alpha\u001b]0;PWN\u0007 Team",
  };
  const createLogin = (stdout: string[], stderr: string[]) =>
    new ComputerLogin({
      client: {
        async authorize() {
          return {
            deviceCode: "device-secret",
            userCode: "ABCD-EFGH",
            verificationUri: "https://auth.example/activate",
            expiresInSeconds: 600,
            intervalSeconds: 5,
          };
        },
        async pollToken() {
          return {
            status: "authorized",
            credential: { accessToken: "access-secret", tokenType: "Bearer" },
          } as const;
        },
        async listWorkspaces() {
          return [workspace];
        },
      },
      store: { async save() {} },
      writeLine: (line) => stdout.push(line),
      writeProgressLine: (line) => stderr.push(line),
      sleep: async () => undefined,
      colors: pc.createColors(false),
    });
  const humanOutput: string[] = [];
  await createLogin(humanOutput, []).run({ serverUrl: "https://coforge.example" });
  const jsonOutput: string[] = [];
  await createLogin(jsonOutput, []).run({ serverUrl: "https://coforge.example", json: true });

  expect(humanOutput.join("\n")).not.toContain("\u001b");
  expect(humanOutput.join("\n")).not.toContain("\u0007");
  expect(JSON.parse(jsonOutput[0]!).workspaces).toEqual([workspace]);
});

test("login waits at the server interval while authorization is pending", async () => {
  const sleeps: number[] = [];
  let polls = 0;
  const client: DeviceAuthorizationClient = {
    async authorize() {
      return {
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example/activate",
        expiresInSeconds: 600,
        intervalSeconds: 7,
      };
    },
    async pollToken() {
      polls += 1;
      if (polls === 1) return { status: "pending" };
      return {
        status: "authorized",
        credential: { accessToken: "access-secret", tokenType: "Bearer" },
      };
    },
    async listWorkspaces() {
      return [];
    },
  };

  await new ComputerLogin({
    client,
    store: { async save() {} },
    writeLine: () => undefined,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  }).run({ serverUrl: "https://coforge.example" });

  expect(polls).toBe(2);
  expect(sleeps).toEqual([7_000, 7_000]);
});

test("login increases the polling interval after slow_down", async () => {
  const sleeps: number[] = [];
  let polls = 0;
  const client: DeviceAuthorizationClient = {
    async authorize() {
      return {
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example/activate",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      };
    },
    async pollToken() {
      polls += 1;
      if (polls === 1) return { status: "slow_down" };
      return {
        status: "authorized",
        credential: { accessToken: "access-secret", tokenType: "Bearer" },
      };
    },
    async listWorkspaces() {
      return [];
    },
  };

  await new ComputerLogin({
    client,
    store: { async save() {} },
    writeLine: () => undefined,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  }).run({ serverUrl: "https://coforge.example" });

  expect(sleeps).toEqual([5_000, 10_000]);
});

test("login backs off after a polling timeout and bounds each request by the deadline", async () => {
  const sleeps: number[] = [];
  const timeouts: Array<number | undefined> = [];
  let polls = 0;
  let now = 0;
  const client: DeviceAuthorizationClient = {
    async authorize() {
      return {
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example/activate",
        expiresInSeconds: 30,
        intervalSeconds: 5,
      };
    },
    async pollToken(_deviceCode, timeoutMilliseconds) {
      timeouts.push(timeoutMilliseconds);
      polls += 1;
      if (polls === 1) {
        now += 2_000;
        return { status: "network_timeout" };
      }
      return {
        status: "authorized",
        credential: { accessToken: "access-secret", tokenType: "Bearer" },
      };
    },
    async listWorkspaces() {
      return [];
    },
  };

  await new ComputerLogin({
    client,
    store: { async save() {} },
    writeLine: () => undefined,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    now: () => now,
  }).run({ serverUrl: "https://coforge.example" });

  expect(sleeps).toEqual([5_000, 10_000]);
  expect(timeouts).toEqual([25_000, 13_000]);
});

test("login stops when a timed-out poll consumes the remaining device-code lifetime", async () => {
  const timeouts: Array<number | undefined> = [];
  let now = 0;
  const login = new ComputerLogin({
    client: {
      async authorize() {
        return {
          deviceCode: "device-secret",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.example/activate",
          expiresInSeconds: 20,
          intervalSeconds: 5,
        };
      },
      async pollToken(_deviceCode, timeoutMilliseconds) {
        timeouts.push(timeoutMilliseconds);
        now += timeoutMilliseconds!;
        return { status: "network_timeout" };
      },
      async listWorkspaces() {
        throw new Error("must not list workspaces");
      },
    },
    store: { async save() {} },
    writeLine: () => undefined,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    now: () => now,
  });

  await expect(login.run({ serverUrl: "https://coforge.example" })).rejects.toMatchObject({
    code: "AUTH_DEVICE_CODE_EXPIRED",
  });
  expect(timeouts).toEqual([15_000]);
});

test("login reports a stable error when the device code expires locally", async () => {
  const login = new ComputerLogin({
    client: {
      async authorize() {
        return {
          deviceCode: "device-secret",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.example/activate",
          expiresInSeconds: 4,
          intervalSeconds: 5,
        };
      },
      async pollToken() {
        throw new Error("must not poll");
      },
      async listWorkspaces() {
        throw new Error("must not list workspaces");
      },
    },
    store: { async save() {} },
    writeLine: () => undefined,
    sleep: async () => undefined,
  });

  await expect(login.run({ serverUrl: "https://coforge.example" })).rejects.toMatchObject({
    code: "AUTH_DEVICE_CODE_EXPIRED",
  });
});
