import { expect, test } from "bun:test";
import {
  encodeAgentWorkspaceFileReadResult,
  encodeAgentWorkspaceFilesListResult,
  type AgentWorkspaceFileReadRequest,
  type AgentWorkspaceFileReadResult,
  type AgentWorkspaceFilesListRequest,
  type AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";
import {
  AgentWorkspaceFilesQuery,
  type WorkspaceFilesAssignment,
} from "../src/server/agents/agent-workspace-files.server";
import {
  createAgentWorkspaceFileReadResultMethod,
  createAgentWorkspaceFilesListResultMethod,
} from "../src/server/centrifugo/agent-workspace-files-cache.server";

function query(overrides: {
  findOwned: () => Promise<WorkspaceFilesAssignment | undefined>;
  online?: () => Promise<boolean>;
  publishList?: (request: AgentWorkspaceFilesListRequest) => Promise<void>;
  publishRead?: (request: AgentWorkspaceFileReadRequest) => Promise<void>;
  listRead: () => Promise<AgentWorkspaceFilesListResult | undefined>;
  readRead?: () => Promise<AgentWorkspaceFileReadResult | undefined>;
  cleared?: () => void;
  timing?: { now: () => number; wait: () => Promise<void>; timeoutMs: number };
}) {
  return new AgentWorkspaceFilesQuery(
    {
      findOwned: overrides.findOwned,
      online: overrides.online ?? (async () => true),
      publishList: overrides.publishList ?? (async () => {}),
      publishRead: overrides.publishRead ?? (async () => {}),
      listResults: {
        begin: async () => {},
        read: overrides.listRead,
        clear: async () => overrides.cleared?.(),
      },
      readResults: {
        begin: async () => {},
        read: overrides.readRead ?? (async () => undefined),
        clear: async () => overrides.cleared?.(),
      },
    },
    overrides.timing,
  );
}

test("Workspace Files list binds the owner's assignment and rechecks it before returning metadata", async () => {
  let assignment: WorkspaceFilesAssignment | undefined = {
    computerId: "computer",
    revision: "one",
  };
  let request: AgentWorkspaceFilesListRequest | undefined;
  let reads = 0;
  let cleared = 0;
  const q = query({
    findOwned: async () => {
      reads++;
      return assignment;
    },
    publishList: async (value) => {
      request = value;
    },
    listRead: async () => {
      assignment = undefined; // Membership/ownership revoked while waiting.
      return {
        ...request!,
        status: "ok",
        rootPath: "/home/agent",
        entries: [],
      } satisfies AgentWorkspaceFilesListResult;
    },
    cleared: () => cleared++,
  });
  expect(await q.list({ userId: "owner", workspaceId: "workspace" }, "agent", "", false)).toEqual({
    status: "unavailable",
  });
  expect(request).toMatchObject({
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
  });
  expect(reads).toBe(2);
  expect(cleared).toBe(1);
});

test.each(["ready", "offline", "timeout", "moved", "reconfigured", "wrong-result"])(
  "Workspace Files list handles %s without leaking stale metadata",
  async (scenario) => {
    let assignment: WorkspaceFilesAssignment = { computerId: "computer", revision: "one" };
    let request: AgentWorkspaceFilesListRequest | undefined;
    let now = 0;
    const q = query({
      findOwned: async () => assignment,
      online: async () => scenario !== "offline",
      publishList: async (value) => {
        request = value;
      },
      listRead: async () => {
        if (scenario === "timeout") return undefined;
        if (scenario === "moved") assignment = { ...assignment, computerId: "other" };
        if (scenario === "reconfigured") assignment = { ...assignment, revision: "two" };
        return {
          ...request!,
          agentId: scenario === "wrong-result" ? "other" : "agent",
          status: "ok",
          rootPath: "/home/agent",
          entries: [],
        };
      },
      timing: {
        now: () => now,
        wait: async () => {
          now += 100;
        },
        timeoutMs: 200,
      },
    });
    const response = await q.list(
      { userId: "owner", workspaceId: "workspace" },
      "agent",
      "",
      false,
    );
    expect(response.status).toBe(
      scenario === "ready" || scenario === "offline" || scenario === "timeout"
        ? scenario
        : "unavailable",
    );
    if (scenario === "offline") expect(request).toBeUndefined();
  },
);

test("Workspace file read binds the owner's assignment and rechecks it before returning content", async () => {
  let assignment: WorkspaceFilesAssignment | undefined = {
    computerId: "computer",
    revision: "one",
  };
  let request: AgentWorkspaceFileReadRequest | undefined;
  const q = query({
    findOwned: async () => assignment,
    publishRead: async (value) => {
      request = value;
    },
    listRead: async () => undefined,
    readRead: async () => {
      assignment = undefined;
      return {
        ...request!,
        status: "ok",
        sizeBytes: 3,
        modifiedAtMs: 1,
        text: "abc",
        contentType: "",
        contentBase64: "",
      } satisfies AgentWorkspaceFileReadResult;
    },
  });
  expect(await q.read({ userId: "owner", workspaceId: "workspace" }, "agent", "a.txt")).toEqual({
    status: "unavailable",
  });
});

test("Workspace Files list result RPC trusts daemon claims rather than claimed payload scope", async () => {
  const result: AgentWorkspaceFilesListResult = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    dirPath: "",
    includeHidden: false,
    status: "ok",
    rootPath: "/home/agent",
    entries: [],
  };
  let accepted = 0;
  const method = createAgentWorkspaceFilesListResultMethod({
    accept: async () => {
      accepted++;
    },
  });
  const bytes = encodeAgentWorkspaceFilesListResult(result);
  for (const principal of [
    { userId: "", workspaceId: "workspace", computerId: "computer" },
    { userId: "user", workspaceId: "other", computerId: "computer" },
    { userId: "user", workspaceId: "workspace", computerId: "other" },
    { userId: "user", workspaceId: "workspace", computerId: "computer", agentId: "agent" },
  ])
    expect(await method(bytes, { principal })).toMatchObject({ code: 403 });
  expect(accepted).toBe(0);
  expect(
    await method(bytes, {
      principal: { userId: "user", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toBeInstanceOf(Uint8Array);
  expect(accepted).toBe(1);
});

test("Workspace file read result RPC trusts daemon claims rather than claimed payload scope", async () => {
  const result: AgentWorkspaceFileReadResult = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    path: "a.txt",
    status: "ok",
    sizeBytes: 3,
    modifiedAtMs: 1,
    text: "abc",
    contentType: "",
    contentBase64: "",
  };
  let accepted = 0;
  const method = createAgentWorkspaceFileReadResultMethod({
    accept: async () => {
      accepted++;
    },
  });
  const bytes = encodeAgentWorkspaceFileReadResult(result);
  expect(
    await method(bytes, {
      principal: { userId: "", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toMatchObject({ code: 403 });
  expect(accepted).toBe(0);
  expect(
    await method(bytes, {
      principal: { userId: "user", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toBeInstanceOf(Uint8Array);
  expect(accepted).toBe(1);
});
