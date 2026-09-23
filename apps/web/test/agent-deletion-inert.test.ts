import { describe, expect, test } from "bun:test";
import { decodeAgentStartIntent } from "@lrm/coforge-sdk/internal";

import { ManageAgents } from "@/server/agents/manage-agents.server";
import { AgentControl } from "@/server/agents/agent-control.server";
import { AgentEnvironment } from "@/server/agents/agent-environment.server";
import { ChangeAgentRuntimeCredential } from "@/server/agents/change-agent-runtime-credential.server";
import type { AgentControlAgent, AgentControlStore } from "@/server/agents/agent-control.server";
import type {
  AgentRecord,
  AgentRepository,
} from "@/server/db/repositories/agent.repositories.server";

/**
 * Deleting an Agent is durable. The review of the first implementation found that only
 * `AgentControl.execute()` refused a deleted Agent, so the Agent's own owner could still restart it
 * by editing its runtime configuration. These tests pin the invariant at the seam every start
 * funnels through.
 */

function controlAgent(deletedAt: Date | null): AgentControlAgent {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    ownerId: "user-1",
    visibility: "public",
    deletedAt,
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
}

function controlStore(agent: AgentControlAgent) {
  const published: string[] = [];
  let current = structuredClone(agent);
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => structuredClone(current),
    replace: async (_before, state) => {
      current = { ...current, state };
      return true;
    },
  };
  return { store, published };
}

function control(agent: AgentControlAgent) {
  const { store, published } = controlStore(agent);
  const instance = new AgentControl(
    store,
    {
      publish: async (_channel: string, bytes: Uint8Array) => {
        // Complete the operation like a real Daemon would, so `publishStart` settles rather than
        // waiting on a result that never arrives.
        const intent = decodeAgentStartIntent(bytes);
        published.push("publish");
        await instance.result(intent, {
          ...intent,
          provider: intent.provider!,
          epoch: intent.controlEpoch!,
          launchId: intent.launchId!,
          phase: "started",
          sequence: 1,
        });
      },
    },
    { run: async (_id, callback) => callback() },
  );
  return { instance, published };
}

const startIntent = {
  protocolMajor: 1 as const,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  provider: "pi" as const,
  model: "",
  reasoning: "",
};

describe("a deleted Agent is never started again", () => {
  test("publishStart refuses a deleted Agent and publishes nothing", async () => {
    const { instance, published } = control(controlAgent(new Date("2026-09-18T04:00:00Z")));
    await expect(instance.publishStart(startIntent, "user-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(published).toEqual([]);
  });

  test("recover refuses a deleted Agent and publishes nothing", async () => {
    const { instance, published } = control(controlAgent(new Date("2026-09-18T04:00:00Z")));
    await expect(instance.recover(startIntent, "user-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(published).toEqual([]);
  });

  test("publishStart still starts a live Agent (control)", async () => {
    const { instance, published } = control(controlAgent(null));
    await instance.publishStart(startIntent, "user-1");
    expect(published).toEqual(["publish"]);
  });
});

function agentRecord(deletedAt: Date | null): AgentRecord {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: "doomed",
    displayName: "Doomed",
    description: "",
    computerId: "computer-1",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deletedAt,
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "old",
      modelProvider: "",
      reasoning: "",
    },
  };
}

function manageAgents(record: AgentRecord) {
  const starts: string[] = [];
  const repository: AgentRepository = {
    getById: async (id) => (id === record.id ? record : undefined),
    listInWorkspace: async () => [record],
    listForComputer: async () => [record],
    listDeletedForComputer: async () => [record],
    listOwnedInWorkspace: async () => [record],
    create: async () => record,
    update: async (_id, input) => Object.assign(record, input),
  };
  const management = new ManageAgents(
    repository,
    {
      start: async (intent) => {
        starts.push(intent.agentId);
      },
      stop: async () => {},
    },
    { canRun: async () => true },
    { run: async (_id, callback) => callback() },
  );
  return { management, starts };
}

describe("ManageAgents.update on a deleted Agent", () => {
  test("a live Agent restarts on a runtime change (control)", async () => {
    const { management, starts } = manageAgents(agentRecord(null));
    await management.update(
      { userId: "user-1", workspaceId: "workspace-1" },
      { agentId: "agent-1", description: "", provider: "codex", model: "new" },
    );
    expect(starts).toEqual(["agent-1"]);
  });

  test("a deleted Agent is not restarted by its owner editing it", async () => {
    const { management, starts } = manageAgents(agentRecord(new Date("2026-09-18T04:00:00Z")));
    // The edit is refused outright (NOT_FOUND, the same answer a deleted Agent's profile gives),
    // and nothing is published — the delete stays durable.
    await expect(
      management.update(
        { userId: "user-1", workspaceId: "workspace-1" },
        { agentId: "agent-1", description: "", provider: "codex", model: "new" },
      ),
    ).rejects.toMatchObject({ name: "AppError", code: "NOT_FOUND" });
    expect(starts).toEqual([]);
  });
});

/** The two remaining mutations that could rewrite (and restart) a deleted Agent. */
function credentialFixture(deletedAt: Date | null) {
  const events: string[] = [];
  const record = agentRecord(deletedAt);
  const credentialChange = new ChangeAgentRuntimeCredential(
    { getById: async () => record },
    { save: async () => ({ providerId: "anthropic", hint: "" }), delete: async () => {} },
    {
      start: async () => {
        events.push("start");
      },
      stop: async () => {
        events.push("stop");
      },
    },
    { run: async (_id, callback) => callback() },
  );
  return { credentialChange, events };
}

function environmentFixture(deletedAt: Date | null) {
  const events: string[] = [];
  const record = agentRecord(deletedAt);
  const environment = new AgentEnvironment(
    {
      findOwnedAgent: async () => ({ runtimeConfig: record.runtimeConfig }),
      updateRuntimeConfig: async () => {
        events.push("write");
      },
    },
    { getById: async () => record },
    {
      start: async () => {
        events.push("start");
      },
      stop: async () => {
        events.push("stop");
      },
    },
    { run: async (_id, callback) => callback() },
    new Uint8Array(32),
  );
  return { environment, events };
}

describe("the remaining deleted-Agent mutations", () => {
  test("a live Agent's runtime credential can still be changed (control)", async () => {
    const { credentialChange, events } = credentialFixture(null);
    await credentialChange.save({ userId: "user-1", workspaceId: "workspace-1" }, "agent-1", "k");
    expect(events).toEqual(["stop", "start"]);
  });

  test("a deleted Agent's runtime credential is refused without a restart", async () => {
    const { credentialChange, events } = credentialFixture(new Date("2026-09-18T04:00:00Z"));
    await expect(
      credentialChange.save({ userId: "user-1", workspaceId: "workspace-1" }, "agent-1", "k"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(events).toEqual([]);
  });

  test("a live Agent's environment can still be saved (control)", async () => {
    const { environment, events } = environmentFixture(null);
    await environment.save({ userId: "user-1", workspaceId: "workspace-1" }, "agent-1", {
      TOKEN: "value",
    });
    expect(events).toEqual(["stop", "write", "start"]);
  });

  test("a deleted Agent's environment is refused without a restart", async () => {
    const { environment, events } = environmentFixture(new Date("2026-09-18T04:00:00Z"));
    // A deleted Agent answers NOT_FOUND, not the authorization-shaped error the ownership check
    // above it uses, so the refusal is the same one every other live-view lookup gives.
    await expect(
      environment.save({ userId: "user-1", workspaceId: "workspace-1" }, "agent-1", {
        TOKEN: "value",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(events).toEqual([]);
  });
});
