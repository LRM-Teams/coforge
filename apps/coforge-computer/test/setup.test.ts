import { expect, test } from "bun:test";

import { ComputerSetup, type ComputerSetupOptions } from "../src/setup";
import type { AccessibleWorkspace, Credential } from "../src/login";

const credential: Credential = { accessToken: "access-secret", tokenType: "Bearer" };
const workspaces: AccessibleWorkspace[] = [
  { id: "workspace-id-a", slug: "workspace-a", name: "Workspace A" },
  { id: "workspace-id-b", slug: "workspace-b", name: "Workspace B" },
];

test("setup selects an accessible Workspace by slug and persists its stable id", async () => {
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
    },
    writeLine: (line) => stdout.push(line),
  });

  const result = await setup.run({ workspaceSlug: "workspace-b" });

  expect(result.workspace).toEqual(workspaces[1]!);
  expect(saved).toEqual([{ id: "workspace-id-b", slug: "workspace-b" }]);
  expect(stdout.join("\n")).toContain("Workspace B (workspace-b)");
  expect(stdout.join("\n")).toContain("No server binding was created");
  expect(stdout.join("\n")).toContain("No daemon was started");
});

test("setup without a slug interactively selects exactly one accessible Workspace", async () => {
  const choices: AccessibleWorkspace[][] = [];
  const saved: string[] = [];
  const setup = createSetup({
    selectWorkspace: async (available) => {
      choices.push(available);
      return available[0]!;
    },
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveWorkspace(workspace) {
        saved.push(workspace.id);
        return "/config/workspaces/id/config.json";
      },
    },
  });

  await setup.run({});

  expect(choices).toEqual([workspaces]);
  expect(saved).toEqual(["workspace-id-a"]);
});

test("setup JSON output is one stable object and contains no credential", async () => {
  const stdout: string[] = [];
  const setup = createSetup({ writeLine: (line) => stdout.push(line) });

  await setup.run({ workspaceSlug: "workspace-a", json: true });

  expect(stdout).toHaveLength(1);
  expect(JSON.parse(stdout[0]!)).toEqual({
    ok: true,
    workspace: workspaces[0],
    config_path: "/config/workspaces/id/config.json",
    server_binding_created: false,
    daemon_started: false,
  });
  expect(stdout[0]).not.toContain("access-secret");
});

test("setup rejects a slug outside the accessible Workspace list", async () => {
  const setup = createSetup();

  await expect(setup.run({ workspaceSlug: "missing" })).rejects.toMatchObject({
    code: "SETUP_WORKSPACE_NOT_FOUND",
  });
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
    },
    credentials: {
      async load() {
        return credential;
      },
    },
    client: {
      async listWorkspaces() {
        return workspaces;
      },
    },
    selectWorkspace: async () => {
      throw new Error("interactive selection was not expected");
    },
    writeLine: () => undefined,
    ...overrides,
  });
}
