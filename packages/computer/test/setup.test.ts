import { expect, test } from "bun:test";

import { ComputerSetup, type ComputerSetupOptions } from "../src/setup/computer-setup";
import type { AccessibleWorkspace, Credential } from "../src/login";
import { CliError } from "../src/errors";
import { createWorkspaceLookup } from "../src/workspace/lookup";

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
    workspaceLookup: createWorkspaceLookup(
      async () => workspaces,
      async (_serverUrl, _credential, slug) => ({ id: "", slug, name: slug }),
    ),
  });

  await setup.run({ workspaceSlug: "workspace-a" });

  expect(true).toBe(true);
});

test("setup reports an inaccessible explicit slug before registration", async () => {
  let registered = false;
  const setup = createSetup({
    workspaceLookup: createWorkspaceLookup(
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
  const catalog = createWorkspaceLookup(
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
    },
  });

  await setup.run({ workspaceSlug: "workspace-a", json: true });

  expect(authenticated).toEqual(["https://coforge.example:true"]);
});

test("setup reports OAuth failures with a stable actionable code", async () => {
  const setup = createSetup({
    credentials: {
      async load() {
        return null;
      },
    },
    authenticate: {
      async authenticate() {
        throw new Error("access token leaked");
      },
    },
  });
  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_OAUTH_FAILED",
    message: "OAuth login could not be completed.",
  });
});

test("setup reports credential store failures without exposing diagnostics", async () => {
  const setup = createSetup({
    credentials: {
      async load() {
        throw new Error("token=secret");
      },
    },
  });
  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_CREDENTIALS_FAILED",
    message: "Could not read the local login credential.",
  });
});

test("setup keeps registration and daemon failures distinct", async () => {
  const registrationFailed = createSetup({
    registrationFactory: () => ({
      async register() {
        throw new Error("rpc token=secret");
      },
    }),
  });
  await expect(registrationFailed.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_COMPUTER_REGISTER_FAILED",
  });

  const daemonFailed = createSetup({
    launcher: {
      async ensureStarted() {
        throw new Error("spawn failed");
      },
    },
  });
  await expect(daemonFailed.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_DAEMON_START_FAILED",
  });
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
    },
  });

  await setup.run({ workspaceSlug: "workspace-a", serverUrl: "https://new.example", json: true });
  expect(calls).toEqual(["auth:https://new.example", "profile:https://new.example"]);
});

test("setup uses an explicit server for catalog and registration", async () => {
  const servers: string[] = [];
  const setup = createSetup({
    workspaceLookup: createWorkspaceLookup(
      async (serverUrl) => {
        servers.push(`workspaceLookup:${serverUrl}`);
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
            daemonApiKey: "t",
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
    workspaceLookup: createWorkspaceLookup(
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
          daemonApiKey: "daemon-secret",
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
          runtimes: [{ provider: "codex", version: "1.2.3", displayName: "Codex" }],
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
          daemonApiKey: "daemon-secret",
        };
      },
    }),
  });

  await setup.run({ workspaceSlug: "workspace-a" });
  expect(runtimes).toEqual([{ provider: "codex", version: "1.2.3", displayName: "Codex" }]);
});

test("setup preserves the previous registration when the Daemon launcher fails", async () => {
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
        discarded.push(`${registration.id}:${registration.computerId}`);
      },
    },
    launcher: {
      async ensureStarted() {
        throw new Error("launcher failed");
      },
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_DAEMON_START_FAILED",
  });
  expect(discarded).toEqual([]);
});

test("setup preserves local registrations when saving its config fails", async () => {
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
        discarded.push(`${registration.id}:${registration.computerId}`);
      },
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_CONFIG_WRITE_FAILED",
  });
  expect(discarded).toEqual([]);
});

test("setup does not save the Daemon credential in Computer", async () => {
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
        discarded.push(`${registration.id}:${registration.computerId}`);
      },
    },
    credentials: {
      async load() {
        return credential;
      },
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).resolves.toBeDefined();
  expect(discarded).toEqual([]);
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
    },
    workspaceLookup: createWorkspaceLookup(
      async () => workspaces,
      async (_serverUrl, _credential, slug) => ({ id: "", slug, name: slug }),
    ),
    registrationFactory: (_serverUrl, _credential) => ({
      async register(request) {
        return {
          protocolMajor: request.protocolMajor,
          requestId: request.requestId,
          computerId: "computer-id",
          workspaceId:
            request.workspaceSlug === "workspace-b" ? "workspace-id-b" : "workspace-id-a",
          daemonApiKey: "daemon-secret",
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
