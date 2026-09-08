import { expect, test } from "bun:test";
import {
  encodeAgentSkillsListResult,
  type AgentSkillsListRequest,
  type AgentSkillsListResult,
} from "@coforge/protocol";
import { AgentSkillsQuery, type SkillsAssignment } from "../src/server/agents/agent-skills.server";
import { createAgentSkillsListResultMethod } from "../src/server/centrifugo/agent-skills-cache.server";

test("Skills query binds the owner's assignment and rechecks it before returning metadata", async () => {
  let assignment: { computerId: string; provider: "codex"; revision: string } | undefined = {
    computerId: "computer",
    provider: "codex",
    revision: "one",
  };
  let request: AgentSkillsListRequest | undefined;
  let reads = 0;
  let cleared = 0;
  const query = new AgentSkillsQuery({
    findOwned: async () => {
      reads++;
      return assignment;
    },
    online: async () => true,
    publish: async (value) => {
      request = value;
    },
    results: {
      begin: async () => {},
      read: async () => {
        assignment = undefined; // Membership/ownership revoked while waiting.
        return {
          ...request!,
          scannedAtMs: 1,
          global: {
            status: "ok",
            entries: [
              { name: "private", description: "", sourcePath: "~/.agents/skills/private/SKILL.md" },
            ],
            directories: [],
          },
          workspace: { status: "ok", entries: [], directories: [] },
        } satisfies AgentSkillsListResult;
      },
      clear: async () => {
        cleared++;
      },
    },
  });
  expect(await query.get({ userId: "owner", workspaceId: "workspace" }, "agent")).toEqual({
    status: "unavailable",
  });
  expect(request).toMatchObject({
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex",
  });
  expect(reads).toBe(2);
  expect(cleared).toBe(1);
  request = undefined;
  expect(await query.get({ userId: "other", workspaceId: "workspace" }, "agent")).toEqual({
    status: "unavailable",
  });
  expect(request).toBeUndefined();
});

test.each(["ready", "offline", "timeout", "moved", "reconfigured", "wrong-result"])(
  "Skills query handles %s without leaking stale metadata",
  async (scenario) => {
    let assignment: SkillsAssignment = {
      computerId: "computer",
      provider: "codex",
      revision: "one",
    };
    let request: AgentSkillsListRequest | undefined;
    let now = 0;
    const query = new AgentSkillsQuery(
      {
        findOwned: async () => assignment,
        online: async () => scenario !== "offline",
        publish: async (value) => {
          request = value;
        },
        results: {
          begin: async () => {},
          clear: async () => {},
          read: async () => {
            if (scenario === "timeout") return undefined;
            if (scenario === "moved") assignment = { ...assignment, computerId: "other" };
            if (scenario === "reconfigured") assignment = { ...assignment, revision: "two" };
            return {
              ...request!,
              agentId: scenario === "wrong-result" ? "other" : "agent",
              scannedAtMs: 1,
              global: { status: "ok", entries: [], directories: [] },
              workspace: { status: "ok", entries: [], directories: [] },
            };
          },
        },
      },
      {
        now: () => now,
        wait: async () => {
          now += 100;
        },
        timeoutMs: 200,
      },
    );
    const response = await query.get({ userId: "owner", workspaceId: "workspace" }, "agent");
    expect(response.status).toBe(
      scenario === "ready" || scenario === "offline" || scenario === "timeout"
        ? scenario
        : "unavailable",
    );
    if (scenario === "offline") expect(request).toBeUndefined();
  },
);

test("Skills result RPC trusts daemon claims rather than claimed payload scope", async () => {
  const result: AgentSkillsListResult = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex",
    scannedAtMs: 1,
    global: { status: "ok", entries: [], directories: [] },
    workspace: { status: "ok", entries: [], directories: [] },
  };
  let accepted = 0;
  const method = createAgentSkillsListResultMethod({
    accept: async () => {
      accepted++;
    },
  });
  const bytes = encodeAgentSkillsListResult(result);
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
