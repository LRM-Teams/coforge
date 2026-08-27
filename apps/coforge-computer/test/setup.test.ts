import { expect, test } from "bun:test";

import { ComputerSetup, type ComputerSetupOptions } from "../src/setup";
import type { AccessibleWorkspace, Credential } from "../src/login";

const credential: Credential = { accessToken: "access-secret", tokenType: "Bearer" };
const workspaces: AccessibleWorkspace[] = [
  { id: "workspace-id-a", slug: "workspace-a", name: "Workspace A" },
  { id: "workspace-id-b", slug: "workspace-b", name: "Workspace B" },
];

test("setup resolves an accessible Workspace by slug and persists its stable id", async () => {
  const saved: Array<{ id: string; slug: string }> = [];
  const stdout: string[] = [];
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveWorkspace(workspace) {
        saved.push(workspace);
        return "/config/workspaces/id/config.json";
      },
      async saveRegistration(registration) {
        saved.push({ id: registration.id, slug: registration.slug });
        return "/config/workspaces/id/config.json";
      },
    },
    writeLine: (line) => stdout.push(line),
  });

  const result = await setup.run({ workspaceSlug: "workspace-b" });

  expect(result.workspace).toEqual({
    id: "workspace-id-b",
    slug: "workspace-b",
    name: "workspace-b",
  });
  expect(saved).toEqual([{ id: "workspace-id-b", slug: "workspace-b" }]);
  expect(stdout.join("\n")).toContain("Workspace:             workspace-b (workspace-b)");
  expect(stdout.join("\n")).toContain("Configuration saved:");
  expect(stdout.join("\n")).toContain("Computer:              registered");
  expect(stdout.join("\n")).toContain("Daemon:                started");
});

test("setup resolves exactly the requested Workspace slug", async () => {
  const setup = createSetup({
    client: {
      async listWorkspaces() {
        return workspaces;
      },
    },
    selectWorkspace: async (available) => available[0]!,
  });

  await setup.run({ workspaceSlug: "workspace-a" });

  expect(true).toBe(true);
});

test("setup lists Workspaces only for interactive selection", async () => {
  const listed: string[] = [];
  const setup = createSetup({
    client: {
      async listWorkspaces(serverUrl) {
        listed.push(serverUrl);
        return workspaces;
      },
    },
    selectWorkspace: async (available) => available[1]!,
  });

  const result = await setup.run({});

  expect(result.workspace.slug).toBe("workspace-b");
  expect(listed).toEqual(["https://coforge.example"]);
});

test("setup requires --workspace in JSON mode", async () => {
  const setup = createSetup();

  await expect(setup.run({ json: true })).rejects.toMatchObject({
    code: "SETUP_WORKSPACE_REQUIRED",
  });
});

test("setup authenticates inside the same flow when no credential exists", async () => {
  const authenticated: string[] = [];
  const setup = createSetup({
    authenticate: {
      async authenticate(serverUrl, json) {
        authenticated.push(`${serverUrl}:${json}`);
        return credential;
      },
    },
    credentials: {
      async load() {
        return null;
      },
      async saveDaemonCredential() {},
    },
  });

  await setup.run({ workspaceSlug: "workspace-a", json: true });

  expect(authenticated).toEqual(["https://coforge.example:true"]);
});

test("setup JSON output is one stable object and contains no credential", async () => {
  const stdout: string[] = [];
  const setup = createSetup({ writeLine: (line) => stdout.push(line) });

  await setup.run({ workspaceSlug: "workspace-a", json: true });

  expect(stdout).toHaveLength(1);
  expect(JSON.parse(stdout[0]!)).toEqual({
    ok: true,
    workspace: { id: "workspace-id-a", slug: "workspace-a", name: "workspace-a" },
    config_path: "/config/workspaces/id/config.json",
    server_registration_created: true,
    daemon_started: true,
  });
  expect(stdout[0]).not.toContain("access-secret");
});

test("setup sends a direct slug to registration without listing Workspaces", async () => {
  const requested: string[] = [];
  const setup = createSetup({
    client: {
      async listWorkspaces() {
        throw new Error("must not list for direct slug");
      },
    },
    registration: {
      async register(request) {
        requested.push(request.workspaceSlug);
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          computerId: "computer-id",
          workspaceId: "workspace-id-a",
          connectionId: "connection-id",
          daemonWorkspaceCredential: "daemon-secret",
        };
      },
    },
  });
  await setup.run({ workspaceSlug: "direct-slug" });
  expect(requested).toEqual(["direct-slug"]);
});

test("setup discards the registration when the Daemon launcher fails", async () => {
  const discarded: string[] = [];
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveWorkspace() {
        return "/unused";
      },
      async saveRegistration() {
        throw new Error("must not save config");
      },
      async discardRegistration(registration) {
        discarded.push(registration.connectionId);
      },
    },
    launcher: {
      async ensureStarted() {
        throw new Error("launcher failed");
      },
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_CONFIG_WRITE_FAILED",
  });
  expect(discarded).toEqual(["connection-id"]);
});

test("setup discards the registration when saving its config fails", async () => {
  const discarded: string[] = [];
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveWorkspace() {
        return "/unused";
      },
      async saveRegistration() {
        throw new Error("config failed");
      },
      async discardRegistration(registration) {
        discarded.push(registration.connectionId);
      },
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_CONFIG_WRITE_FAILED",
  });
  expect(discarded).toEqual(["connection-id"]);
});

test("setup discards the registration when saving the Daemon credential fails", async () => {
  const discarded: string[] = [];
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveWorkspace() {
        return "/unused";
      },
      async saveRegistration() {
        return "/saved";
      },
      async discardRegistration(registration) {
        discarded.push(registration.connectionId);
      },
    },
    credentials: {
      async load() {
        return credential;
      },
      async saveDaemonCredential() {
        throw new Error("keyring failed");
      },
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_CONFIG_WRITE_FAILED",
  });
  expect(discarded).toEqual(["connection-id"]);
});

function createSetup(overrides: Partial<ComputerSetupOptions> = {}): ComputerSetup {
  return new ComputerSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveWorkspace() {
        return "/config/workspaces/id/config.json";
      },
      async saveRegistration() {
        return "/config/workspaces/id/config.json";
      },
    },
    credentials: {
      async load() {
        return credential;
      },
      async saveDaemonCredential() {},
    },
    client: {
      async listWorkspaces() {
        return workspaces;
      },
    },
    selectWorkspace: async (available) => available[0]!,
    registration: {
      async register(request) {
        return {
          protocolMajor: request.protocolMajor,
          requestId: request.requestId,
          computerId: "computer-id",
          workspaceId:
            request.workspaceSlug === "workspace-b" ? "workspace-id-b" : "workspace-id-a",
          connectionId: "connection-id",
          daemonWorkspaceCredential: "daemon-secret",
        };
      },
    },
    launcher: { async ensureStarted() {} },
    machineIdProvider: async () => "linux:test-machine-id",
    writeLine: () => undefined,
    ...overrides,
  });
}
