import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
import { DaemonRuntime } from "../src/daemon-runtime/runtime";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "../src/connection/daemon-connection";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import { agentWorkspaceDirectory } from "../src/agent-runtime/agent-workspace-path";
import {
  AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD,
  AGENT_WORKSPACE_FILE_READ_RESULT_METHOD,
  decodeAgentWorkspaceFilesListResult,
  decodeAgentWorkspaceFileReadResult,
  encodeAgentWorkspaceFilesListRequest,
  encodeAgentWorkspaceFileReadRequest,
  type AgentWorkspaceFilesListResult,
  type AgentWorkspaceFileReadResult,
} from "@lrm/coforge-sdk/internal";

function makeClient(onRpc: (method: string, bytes: Uint8Array) => void) {
  let connected = () => {};
  let publication = (_data: { channel: string; data: Uint8Array }) => {};
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as typeof connected;
      if (event === "publication") publication = callback as typeof publication;
    },
    connect() {
      connected();
    },
    disconnect() {},
    async rpc(method, bytes) {
      onRpc(method, bytes);
      return new Uint8Array();
    },
  };
  return {
    client,
    publish: (data: { channel: string; data: Uint8Array }) => publication(data),
  };
}

test("WSS Workspace Files query lists a stopped Agent's working directory without launching it", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-routing-"));
  const listResult = Promise.withResolvers<AgentWorkspaceFilesListResult>();
  let inventories = 0;
  const { client, publish } = makeClient((method, bytes) => {
    if (method === AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD)
      listResult.resolve(decodeAgentWorkspaceFilesListResult(bytes));
  });
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save("workspace", "computer", "token");
  const runtime = new DaemonRuntime(
    { workspaceId: "workspace", computerId: "computer", workspaceRoot: root },
    () => {
      throw new Error("Workspace Files must not construct a provider");
    },
    credentials,
    { create: () => new DaemonConnection("wss://example.test", () => client) },
    undefined,
    {
      runtimes: async () => {
        inventories++;
        return [];
      },
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
    join(root, "state"),
  );
  try {
    await Bun.write(
      join(agentWorkspaceDirectory(root, "workspace", "agent"), "notes.md"),
      "workspace notes",
    );
    await Bun.write(
      join(agentWorkspaceDirectory(root, "workspace", "agent"), ".builtin-runtime/inventory.json"),
      "{}",
    );
    await runtime.start({ workspaceId: "workspace", computerId: "computer", workspaceRoot: root });
    publish({
      channel: "daemon:workspace:computer",
      data: encodeAgentWorkspaceFilesListRequest({
        protocolMajor: 1,
        requestId: "request-list",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        dirPath: "",
        includeHidden: true,
      }),
    });
    const result = await listResult.promise;
    expect(result.status).toBe("ok");
    expect(result.entries.map((entry) => entry.name)).toEqual(["notes.md"]);
    expect(inventories).toBe(1);
    expect(runtime.agentProcessManager.size).toBe(0);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("WSS Workspace File read returns a fixture file's exact content", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-file-read-routing-"));
  const readResult = Promise.withResolvers<AgentWorkspaceFileReadResult>();
  const { client, publish } = makeClient((method, bytes) => {
    if (method === AGENT_WORKSPACE_FILE_READ_RESULT_METHOD)
      readResult.resolve(decodeAgentWorkspaceFileReadResult(bytes));
  });
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save("workspace", "computer", "token");
  const runtime = new DaemonRuntime(
    { workspaceId: "workspace", computerId: "computer", workspaceRoot: root },
    () => {
      throw new Error("Workspace Files must not construct a provider");
    },
    credentials,
    { create: () => new DaemonConnection("wss://example.test", () => client) },
    undefined,
    {
      runtimes: async () => [],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
    join(root, "state"),
  );
  try {
    await Bun.write(
      join(agentWorkspaceDirectory(root, "workspace", "agent"), "README.md"),
      "hello from the Agent workspace",
    );
    await runtime.start({ workspaceId: "workspace", computerId: "computer", workspaceRoot: root });
    publish({
      channel: "daemon:workspace:computer",
      data: encodeAgentWorkspaceFileReadRequest({
        protocolMajor: 1,
        requestId: "request-read",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        path: "README.md",
      }),
    });
    const result = await readResult.promise;
    expect(result.status).toBe("ok");
    expect(result.text).toBe("hello from the Agent workspace");
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

// A deterministic concurrency trigger for the shared `#workspaceFilesScanning` guard would need
// either a runtime test hook or an artificially slow filesystem stand-in; neither exists yet in
// this harness. The guard's "second caller sees status: error" behavior is left to be exercised
// once such a hook exists, rather than approximated here with a flaky timing race.
