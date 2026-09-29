import { expect, test } from "bun:test";
import {
  AGENT_MESSAGE_REJECT_METHOD,
  decodeAgentStartIntent,
  RUNTIME_PROVIDER,
  type AgentMessageDeliveryRejection,
} from "@lrm/coforge-sdk/internal";
import {
  AgentControl,
  type AgentControlAgent,
  type AgentControlStore,
} from "#src/server/agents/agent-control.server";
import {
  AgentDeliveryRejectionScopeError,
  AgentDeliveryRejections,
} from "#src/server/agents/agent-delivery-rejection.server";
import { WorkspaceAgentRecovery } from "#src/server/agents/agent-runtime-control.server";

const runtimeConfig = {
  runtime: RUNTIME_PROVIDER.PI,
  provider: { kind: "default" as const },
  model: "default",
  modelProvider: "",
  reasoning: "",
};

/** One Agent on Computer `c`, never launched, with the real `AgentControl` over an in-memory
 * control record. Every Start the server publishes is kept in `starts`. */
function fixture(options: { stoppedAt?: Date; deletedAt?: Date } = {}) {
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    visibility: "public",
    runtimeConfig,
    state: null,
    ...(options.stoppedAt ? { stoppedAt: options.stoppedAt } : {}),
    ...(options.deletedAt ? { deletedAt: options.deletedAt } : {}),
  };
  let reads = 0;
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => {
      reads++;
      return structuredClone(agent);
    },
    replace: async (before, state, replaceOptions) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = {
        ...agent,
        state: structuredClone(state),
        ...(replaceOptions?.stoppedAt !== undefined ? { stoppedAt: replaceOptions.stoppedAt } : {}),
      };
      return true;
    },
  };
  const starts: ReturnType<typeof decodeAgentStartIntent>[] = [];
  const control = new AgentControl(
    store,
    {
      publish: async (_channel, bytes) => {
        try {
          starts.push(decodeAgentStartIntent(bytes));
        } catch {
          // A Stop: only Starts are counted.
        }
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  const conversations = {
    readAgentRecoveryContext: async () => ({ resumeMessages: [], unreadSummary: {} }),
    readPendingAgentDeliveries: async () => [],
  };
  const lock = { run: async <T>(_id: string, work: () => Promise<T>) => work() };
  /** Runs while a rejection waits for the Agent's lock, after its unlocked first read. */
  let whileWaitingForLock = async () => {};
  const rejections = new AgentDeliveryRejections(
    store,
    conversations,
    {
      run: async (id, work) => {
        await whileWaitingForLock();
        return lock.run(id, work);
      },
    },
    control,
  );
  let sequence = 0;
  return {
    starts,
    store,
    control,
    conversations,
    /** How many times the Agent's control record has been read. */
    reads: () => reads,
    lock,
    current: () => agent,
    whileWaitingForLock: (change: () => Promise<unknown>) =>
      void (whileWaitingForLock = async () => void (await change())),
    /** Changes the Agent row outside any control operation (a configuration edit). */
    edit: (change: Partial<AgentControlAgent>) => void (agent = { ...agent, ...change }),
    reject: (computerId = "c") => rejections.receive({ workspaceId: "w", computerId }, rejection()),
    /** The Daemon's terminal answer to the latest published Start. */
    failLatestStart: (errorCode: string) => {
      const start = starts.at(-1)!;
      return control.result(
        { workspaceId: "w", computerId: "c" },
        {
          protocolMajor: 1,
          requestId: start.requestId,
          workspaceId: "w",
          computerId: "c",
          agentId: "a",
          provider: start.provider!,
          epoch: start.controlEpoch!,
          phase: "failed",
          sequence: ++sequence,
          errorCode,
        },
      );
    },
  };
}

function rejection(): AgentMessageDeliveryRejection {
  return {
    protocolMajor: 1,
    requestId: "request-1",
    messageId: "message-1",
    deliveryId: "delivery-1",
    workspaceId: "w",
    agentId: "a",
    sequence: 1,
    reason: "no_process",
    method: AGENT_MESSAGE_REJECT_METHOD,
  };
}

test("a rejection never starts a stopped Agent", async () => {
  const agent = fixture({ stoppedAt: new Date("2026-09-29T00:00:00Z") });

  await expect(agent.reject()).resolves.toBe("stopped");
  await expect(agent.reject()).resolves.toBe("stopped");

  expect(agent.starts).toEqual([]);
  expect(agent.current().state).toBeNull();
});

test("a never-launched Agent is started once, however many rejections arrive meanwhile", async () => {
  const agent = fixture();

  await expect(agent.reject()).resolves.toBe("woken");
  await expect(agent.reject()).resolves.toBe("operation_in_flight");

  expect(agent.starts).toHaveLength(1);
  expect(agent.starts[0]).toMatchObject({ agentId: "a", computerId: "c", provider: "pi" });
  expect(agent.current().state).toMatchObject({ action: "start", phase: "starting" });
});

for (const errorCode of ["launch_failed", "agent_already_running"]) {
  test(`after a Start that ended ${errorCode}, rejections do not start the Agent again`, async () => {
    const agent = fixture();
    await agent.reject();
    await agent.failLatestStart(errorCode);

    await expect(agent.reject()).resolves.toBe("start_failed");
    await expect(agent.reject()).resolves.toBe("start_failed");

    expect(agent.starts).toHaveLength(1);
  });
}

test("a person's Start after a failed Start still starts the Agent", async () => {
  const agent = fixture();
  await agent.reject();
  await agent.failLatestStart("launch_failed");

  await agent.control.execute({
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "user-start",
    action: "start",
  });

  expect(agent.starts).toHaveLength(2);
  expect(agent.starts[1]).toMatchObject({ requestId: "user-start" });
});

test("a Daemon reconnect still starts an Agent whose last Start failed", async () => {
  const agent = fixture();
  await agent.reject();
  await agent.failLatestStart("launch_failed");
  const record = () => ({
    id: agent.current().id,
    workspaceId: "w",
    ownerId: "owner",
    computerId: "c",
    runtimeConfig,
    stoppedAt: null,
    name: "a",
    displayName: "A",
    createdAt: new Date(),
  });
  const recovery = new WorkspaceAgentRecovery(
    {
      getById: async () => record(),
      listOwnedInWorkspace: async () => [],
      listInWorkspace: async () => [],
      listForComputer: async () => [record()],
      listDeletedForComputer: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
    },
    agent.conversations,
    { publish: async () => {} },
    agent.lock,
    { resendPending: async () => {} },
    undefined,
    agent.control,
  );

  await recovery.recoverWorkspace("w", "c", []);

  expect(agent.starts).toHaveLength(2);
  expect(agent.current().state).toMatchObject({ action: "start", phase: "starting" });
});

test("a failed Start recorded for an earlier configuration does not stop a rejection starting the Agent", async () => {
  const agent = fixture();
  await agent.reject();
  await agent.failLatestStart("launch_failed");
  agent.edit({ runtimeConfig: { ...runtimeConfig, model: "fixed-model" } });

  await expect(agent.reject()).resolves.toBe("woken");

  expect(agent.starts).toHaveLength(2);
  expect(agent.starts[1]).toMatchObject({ model: "fixed-model" });
});

test("a rejection from a Computer the Agent is not on is refused", async () => {
  const agent = fixture();

  await expect(agent.reject("another-computer")).rejects.toBeInstanceOf(
    AgentDeliveryRejectionScopeError,
  );
  expect(agent.starts).toEqual([]);
});

test("a rejection never starts a deleted Agent", async () => {
  const agent = fixture({ deletedAt: new Date("2026-09-29T00:00:00Z") });

  await expect(agent.reject()).resolves.toBe("deleted");

  expect(agent.starts).toEqual([]);
});

test("an operation in flight for an earlier configuration still counts as in flight", async () => {
  const agent = fixture();
  await agent.reject();
  agent.edit({ runtimeConfig: { ...runtimeConfig, model: "edited-model" } });

  await expect(agent.reject()).resolves.toBe("operation_in_flight");

  expect(agent.starts).toHaveLength(1);
});

test("a person's Start that lands while a rejection waits for the lock is not doubled", async () => {
  const agent = fixture();
  agent.whileWaitingForLock(() =>
    agent.control.execute({
      userId: "owner",
      workspaceId: "w",
      agentId: "a",
      requestId: "user-start",
      action: "start",
    }),
  );

  await expect(agent.reject()).resolves.toBe("operation_in_flight");

  expect(agent.starts.map(({ requestId }) => requestId)).toEqual(["user-start"]);
});

test("a person's Stop that lands while a rejection waits for the lock keeps the Agent stopped", async () => {
  const agent = fixture();
  agent.whileWaitingForLock(() =>
    agent.control.execute({
      userId: "owner",
      workspaceId: "w",
      agentId: "a",
      requestId: "user-stop",
      action: "stop",
    }),
  );

  await expect(agent.reject()).resolves.toBe("stopped");

  expect(agent.starts).toEqual([]);
});

test("a rejection that wakes the Agent reads it once before its lock and once under it", async () => {
  const agent = fixture();

  await expect(agent.reject()).resolves.toBe("woken");

  expect(agent.starts).toHaveLength(1);
  expect(agent.reads()).toBe(2);
});

test("ready recovery reads the Agent's control record once to start it", async () => {
  const agent = fixture();
  const record = {
    id: "a",
    workspaceId: "w",
    ownerId: "owner",
    computerId: "c",
    runtimeConfig,
    stoppedAt: null,
    name: "a",
    displayName: "A",
    createdAt: new Date(),
  };
  const recovery = new WorkspaceAgentRecovery(
    {
      getById: async () => record,
      listOwnedInWorkspace: async () => [],
      listInWorkspace: async () => [],
      listForComputer: async () => [record],
      listDeletedForComputer: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
    },
    agent.conversations,
    { publish: async () => {} },
    agent.lock,
    { resendPending: async () => {} },
    undefined,
    agent.control,
    agent.store,
  );

  await recovery.recoverWorkspace("w", "c", []);

  expect(agent.starts).toHaveLength(1);
  expect(agent.current().state).toMatchObject({ action: "start", phase: "starting" });
  expect(agent.reads()).toBe(1);
});
