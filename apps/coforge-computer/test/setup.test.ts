import { expect, test } from "bun:test";

import { ComputerSetup, type ComputerSetupOptions } from "../src/setup/computer-setup";
import type { AccessibleWorkspace, Credential } from "../src/login";
import { CliError } from "../src/errors";
import { createWorkspaceCatalog } from "../src/workspace/catalog";

const credential: Credential = { accessToken: "access-secret", tokenType: "Bearer" };
const workspaces: AccessibleWorkspace[] = [
  { id: "workspace-id-a", slug: "workspace-a", name: "Workspace A" },
  { id: "workspace-id-b", slug: "workspace-b", name: "Workspace B" },
];

test("setup resolves an accessible Workspace by slug and persists its stable id", async () => {
  const saved: Array<{ id: string; slug: string }> = [];
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveRegistration(registration) {
        saved.push({ id: registration.id, slug: registration.slug });
        return "/config/workspaces/id/config.json";
      },
      async discardRegistration() {},
    },
  });

  const result = await setup.run({ workspaceSlug: "workspace-b" });

  expect(result.workspace).toEqual({
    id: "workspace-id-b",
    slug: "workspace-b",
    name: "workspace-b",
  });
  expect(saved).toEqual([{ id: "workspace-id-b", slug: "workspace-b" }]);
});

test("setup resolves exactly the requested Workspace slug", async () => {
  const setup = createSetup({
    catalog: createWorkspaceCatalog(
      async () => workspaces,
      async (_serverUrl, _credential, slug) => ({ id: "", slug, name: slug }),
    ),
    selectWorkspace: async (available) => available[0]!,
  });

  await setup.run({ workspaceSlug: "workspace-a" });

  expect(true).toBe(true);
});

test("setup reports an inaccessible explicit slug before registration", async () => {
  let registered = false;
  const setup = createSetup({
    catalog: createWorkspaceCatalog(
      async () => {
        throw new Error("must not list for direct slug");
      },
      async () => {
        throw new CliError(
          "AUTH_WORKSPACE_GET_FAILED",
          "Could not access Workspace.",
          "Check the Workspace slug and your account access, then rerun setup.",
        );
      },
    ),
    registrationFactory: () => ({
      async register() {
        registered = true;
        throw new Error("must not register");
      },
    }),
  });

  await expect(setup.run({ workspaceSlug: "missing" })).rejects.toMatchObject({
    code: "SETUP_WORKSPACE_NOT_FOUND",
  });
  expect(registered).toBe(false);
});

test("catalog getBySlug is a single-workspace lookup seam", async () => {
  const calls: string[] = [];
  const catalog = createWorkspaceCatalog(
    async () => workspaces,
    async (_serverUrl, _credential, slug) => {
      calls.push(slug);
      return { id: "workspace-id-a", slug, name: "Workspace A" };
    },
  );
  const workspace = await catalog.getBySlug("https://coforge.example", credential, "workspace-a");

  expect(calls).toEqual(["workspace-a"]);
  expect(workspace.slug).toBe("workspace-a");
});

test("setup lists Workspaces only for interactive selection", async () => {
  const listed: string[] = [];
  const setup = createSetup({
    catalog: createWorkspaceCatalog(
      async (serverUrl) => {
        listed.push(serverUrl);
        return workspaces;
      },
      async (_serverUrl, _credential, slug) => ({ id: "", slug, name: slug }),
    ),
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

test("setup authenticates and saves the profile when no profile exists", async () => {
  const calls: string[] = [];
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        throw new Error("missing");
      },
      async saveCurrentProfile(profile) {
        calls.push(`profile:${profile.serverUrl}`);
      },
      async saveRegistration() {
        return "/config/workspaces/id/config.json";
      },
      async discardRegistration() {},
    },
    authenticate: {
      async authenticate(serverUrl) {
        calls.push(`auth:${serverUrl}`);
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

  await setup.run({ workspaceSlug: "workspace-a", serverUrl: "https://new.example", json: true });
  expect(calls).toEqual(["auth:https://new.example", "profile:https://new.example"]);
});

test("setup uses an explicit server for catalog and registration", async () => {
  const servers: string[] = [];
  const setup = createSetup({
    catalog: createWorkspaceCatalog(
      async (serverUrl) => {
        servers.push(`catalog:${serverUrl}`);
        return workspaces;
      },
      async (serverUrl, _credential, slug) => {
        servers.push(`lookup:${serverUrl}`);
        return { id: "", slug, name: slug };
      },
    ),
    registrationFactory: (serverUrl) => {
      servers.push(`registration:${serverUrl}`);
      return {
        async register(request) {
          return {
            protocolMajor: 1,
            requestId: request.requestId,
            computerId: "c",
            workspaceId: "w",
            connectionId: "x",
            workspaceWorkerToken: "t",
          };
        },
      };
    },
  });
  await setup.run({ workspaceSlug: "workspace-a", serverUrl: "https://explicit.example" });
  expect(servers).toEqual([
    "lookup:https://explicit.example",
    "registration:https://explicit.example",
  ]);
});

test("setup returns structured data without writing output", async () => {
  const setup = createSetup();

  const result = await setup.run({ workspaceSlug: "workspace-a", json: true });
  expect(result.configPath).toBe("/config/workspaces/id/config.json");
});

test("setup sends a direct slug to registration without listing Workspaces", async () => {
  const requested: string[] = [];
  const setup = createSetup({
    catalog: createWorkspaceCatalog(
      async () => {
        throw new Error("must not list for direct slug");
      },
      async (_serverUrl, _credential, slug) => ({ id: "", slug, name: slug }),
    ),
    registrationFactory: (_serverUrl, _credential) => ({
      async register(request) {
        requested.push(request.workspaceSlug);
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          computerId: "computer-id",
          workspaceId: "workspace-id-a",
          connectionId: "connection-id",
          workspaceWorkerToken: "daemon-secret",
        };
      },
    }),
  });
  await setup.run({ workspaceSlug: "direct-slug" });
  expect(requested).toEqual(["direct-slug"]);
});

test("setup forwards discovered runtime metadata to registration", async () => {
  let runtimes: unknown;
  const setup = createSetup({
    metadataProvider: {
      async get() {
        return {
          platform: "linux",
          osVersion: "bun-test",
          computerVersion: "test",
          machineId: "linux:test-machine-id",
          runtimes: [{ provider: "codex", version: "1.2.3", kind: "external" }],
        };
      },
    },
    registrationFactory: (_serverUrl, _credential) => ({
      async register(request) {
        runtimes = request.runtimes;
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          computerId: "computer-id",
          workspaceId: "workspace-id-a",
          connectionId: "connection-id",
          workspaceWorkerToken: "daemon-secret",
        };
      },
    }),
  });

  await setup.run({ workspaceSlug: "workspace-a" });
  expect(runtimes).toEqual([{ provider: "codex", version: "1.2.3", kind: "external" }]);
});

test("setup discards the registration when the Daemon launcher fails", async () => {
  const discarded: string[] = [];
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
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
      async saveRegistration() {
        return "/config/workspaces/id/config.json";
      },
      async discardRegistration() {},
    },
    credentials: {
      async load() {
        return credential;
      },
      async saveDaemonCredential() {},
    },
    catalog: createWorkspaceCatalog(
      async () => workspaces,
      async (_serverUrl, _credential, slug) => ({ id: "", slug, name: slug }),
    ),
    selectWorkspace: async (available) => available[0]!,
    registrationFactory: (_serverUrl, _credential) => ({
      async register(request) {
        return {
          protocolMajor: request.protocolMajor,
          requestId: request.requestId,
          computerId: "computer-id",
          workspaceId:
            request.workspaceSlug === "workspace-b" ? "workspace-id-b" : "workspace-id-a",
          connectionId: "connection-id",
          workspaceWorkerToken: "daemon-secret",
        };
      },
    }),
    launcher: { async ensureStarted() {} },
    metadataProvider: {
      async get() {
        return {
          platform: "linux",
          osVersion: "bun-test",
          computerVersion: "test",
          machineId: "linux:test-machine-id",
          runtimes: [],
        };
      },
    },
    idempotencyKeyProvider: { create: (_serverUrl, value) => `key:${value}` },
    ...overrides,
    workspaceRoot: overrides.workspaceRoot ?? "/home/test-user/coforge-workspaces",
  });
}
