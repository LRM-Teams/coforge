import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime } from "../src/daemon-runtime/runtime";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "../src/connection/daemon-connection";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import { agentWorkspaceDirectory } from "../src/agent-runtime/agent-workspace-path";
import {
  AGENT_SKILLS_LIST_RESULT_METHOD,
  decodeAgentSkillsListResult,
  encodeAgentSkillsListRequest,
  type AgentSkillsListResult,
} from "@coforge/protocol";

test("WSS Skills query scans a stopped Agent without launching or changing inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-routing-"));
  let connected = () => {};
  let publication = (_data: { channel: string; data: Uint8Array }) => {};
  const result = Promise.withResolvers<AgentSkillsListResult>();
  let inventories = 0;
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
      if (method === AGENT_SKILLS_LIST_RESULT_METHOD)
        result.resolve(decodeAgentSkillsListResult(bytes));
      return new Uint8Array();
    },
  };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save("workspace", "computer", "token");
  const runtime = new DaemonRuntime(
    { workspaceId: "workspace", computerId: "computer", workspaceRoot: root },
    () => {
      throw new Error("Skills must not construct a driver");
    },
    credentials,
    { create: () => new DaemonConnection("wss://example.test", () => client) },
    undefined,
    async () => {
      inventories++;
      return { runtimes: [], catalogs: [] };
    },
    join(root, "state"),
  );
  try {
    await Bun.write(
      join(agentWorkspaceDirectory(root, "workspace", "agent"), ".pi/skills/check/SKILL.md"),
      "---\nname: check\ndescription: Workspace check\n---\nprivate",
    );
    await runtime.start({ workspaceId: "workspace", computerId: "computer", workspaceRoot: root });
    publication({
      channel: "daemon:workspace:computer",
      data: encodeAgentSkillsListRequest({
        protocolMajor: 1,
        requestId: "request",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        provider: "coforge",
      }),
    });
    expect((await result.promise).workspace.entries).toEqual([
      { name: "check", description: "Workspace check", sourcePath: ".pi/skills/check/SKILL.md" },
    ]);
    expect(inventories).toBe(1);
    expect(runtime.agentProcessManager.size).toBe(0);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
