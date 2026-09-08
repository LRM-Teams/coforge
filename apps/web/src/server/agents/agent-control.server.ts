import {
  encodeAgentWorkspaceResetRequest,
  encodeAgentStartIntent,
  encodeAgentStopIntent,
  type AgentControlResult,
  type AgentControlScope,
  type AgentStartIntent,
  type SessionIdentity,
} from "@coforge/protocol";
import { daemonControlChannel, type CentrifugoServerApi } from "../centrifugo/server-api.server";
import type { AgentRuntimeConfig } from "./agent-runtime-config.server";
import { runtimeStartFields } from "./manage-agents.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import type { AgentSessions } from "./agent-sessions.server";

/** Application button intent; never sent as a daemon command. */
export type AgentControlAction = "start" | "stop" | "restart" | "reset-session" | "full-reset";
type AgentControlStep = "stop" | "reset-workspace" | "clear-session" | "start";
const chains: Record<AgentControlAction, readonly AgentControlStep[]> = {
  start: ["start"],
  stop: ["stop"],
  restart: ["stop", "start"],
  "reset-session": ["stop", "clear-session", "start"],
  "full-reset": ["stop", "reset-workspace", "clear-session", "start"],
};
const commands = {
  stop: { pending: "stopping", result: "stopped", completed: "stopped" },
  "reset-workspace": {
    pending: "clearing",
    result: "workspace-reset",
    completed: "workspace-reset",
  },
  start: { pending: "starting", result: "started", completed: "completed" },
} as const;
export type AgentControlState = AgentControlScope & {
  version: 1;
  action: AgentControlAction;
  phase:
    | "stopping"
    | "stopped"
    | "clearing"
    | "workspace-reset"
    | "starting"
    | "completed"
    | "failed";
  configRevision: string;
  identity?: SessionIdentity;
  launchId?: string;
  /** True after this launch has bound its first provider-native identity. */
  launchIdentityBound?: boolean;
  recovered?: boolean;
  controlSequence: number;
  sessionSequence: number;
  errorCode?: string;
};
export type AgentControlAgent = {
  id: string;
  workspaceId: string;
  computerId: string;
  ownerId: string;
  runtimeConfig: AgentRuntimeConfig;
  /** Opaque persisted representation used only for compare-and-swap. */
  storedRuntimeConfig?: unknown;
  storedRuntimeSession?: unknown;
  state: AgentControlState | null;
  currentSessionId?: string | null;
  identity?: SessionIdentity;
};
/** get/replace both require current owner membership and Workspace–Computer assignment. */
export interface AgentControlStore {
  get(agentId: string): Promise<AgentControlAgent | undefined>;
  /** Clear Session, when requested, commits in the same transaction as the next phase. */
  replace(
    before: AgentControlAgent,
    state: AgentControlState,
    options?: { clearSession: boolean },
  ): Promise<boolean>;
}
export type AgentControlView = {
  requestId: string;
  action: AgentControlAction;
  phase: "pending" | "completed" | "failed";
  error?: string;
  recovered?: boolean;
};
export function agentControlRevision(config: unknown) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(config)).digest("hex");
}
function terminal(state: AgentControlState) {
  return state.phase === "completed" || state.phase === "failed";
}
function view(state: AgentControlState): AgentControlView {
  return {
    requestId: state.requestId,
    action: state.action,
    phase: state.phase === "completed" || state.phase === "failed" ? state.phase : "pending",
    ...(state.errorCode ? { error: state.errorCode } : {}),
    ...(state.recovered ? { recovered: true } : {}),
  };
}
function current(agent: AgentControlAgent, state: AgentControlState) {
  return (
    agent.workspaceId === state.workspaceId &&
    agent.computerId === state.computerId &&
    agent.runtimeConfig.runtime === state.provider &&
    agentControlRevision(agent.runtimeConfig) === state.configRevision
  );
}
function sameScope(a: AgentControlScope, b: AgentControlScope) {
  return (
    a.workspaceId === b.workspaceId &&
    a.computerId === b.computerId &&
    a.agentId === b.agentId &&
    a.provider === b.provider &&
    a.epoch === b.epoch &&
    a.requestId === b.requestId
  );
}

/** Shared authorization for control results and independent Session snapshots. */
export async function requireCurrentAgentScope(
  store: AgentControlStore,
  claim: { workspaceId: string; computerId: string },
  input: AgentControlScope,
) {
  const agent = await store.get(input.agentId);
  const state = agent?.state;
  if (
    !agent ||
    !state ||
    claim.workspaceId !== input.workspaceId ||
    claim.computerId !== input.computerId ||
    !sameScope(state, input) ||
    !current(agent, state)
  )
    throw new Error("Stale Agent scope");
  return { ...agent, state };
}

/** One current control operation on the Agent record, not a durable command queue. */
export class AgentControl {
  constructor(
    private readonly store: AgentControlStore,
    private readonly api: Pick<CentrifugoServerApi, "publish">,
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly timing = { timeoutMs: 7_000, wait: () => Bun.sleep(100) },
    private readonly sessions?: AgentSessions,
  ) {}

  /** Ready recovery republishes the current fence; it never waits for buffered daemon ACKs. */
  async recover(intent: AgentStartIntent, userId: string) {
    const agent = await this.authorized(userId, intent.workspaceId, intent.agentId);
    if (agent.state && !terminal(agent.state)) {
      await this.advance(agent.id, agent.state.requestId, intent);
      return;
    }
    const state = await this.begin(agent, "start", intent.requestId);
    await this.publishCurrent(agent.id, state.requestId, intent);
  }
  private async advance(agentId: string, requestId: string, recovery?: AgentStartIntent) {
    const agent = await this.store.get(agentId);
    const state = agent?.state;
    if (!agent || !state || state.requestId !== requestId || !current(agent, state)) return;
    if (state.phase === "stopped" || state.phase === "workspace-reset") {
      const chain = chains[state.action];
      const completed = state.phase === "stopped" ? "stop" : "reset-workspace";
      let index = chain.indexOf(completed) + 1;
      const clearSession = chain[index] === "clear-session";
      if (clearSession) index++;
      const next = chain[index];
      if (next === "clear-session") throw new Error("Invalid Agent control chain");
      const { identity, launchId: _launch, ...fields } = state;
      if (
        !(await this.store.replace(
          agent,
          {
            ...fields,
            phase: next ? commands[next].pending : "completed",
            sessionSequence: 0,
            ...(!clearSession && identity ? { identity } : {}),
          },
          { clearSession },
        ))
      )
        return;
    }
    await this.publishCurrent(agentId, requestId, recovery);
  }
  async execute(input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    requestId: string;
    action: "restart" | "reset-session" | "full-reset";
    confirmed?: boolean;
  }): Promise<AgentControlView> {
    if (input.action === "full-reset" && input.confirmed !== true)
      throw new Error("Full reset confirmation is required");
    await this.runtimeLock.run(input.agentId, async () => {
      const agent = await this.authorized(input.userId, input.workspaceId, input.agentId);
      await this.begin(agent, input.action, input.requestId);
    });
    return this.drive(input.agentId, input.requestId);
  }
  private async authorized(userId: string, workspaceId: string, agentId: string) {
    const agent = await this.store.get(agentId);
    if (!agent || agent.ownerId !== userId || agent.workspaceId !== workspaceId)
      throw new Error("Agent is not authorized or assigned");
    return agent;
  }
  private async begin(agent: AgentControlAgent, action: AgentControlAction, requestId: string) {
    const old = agent.state;
    if (old?.requestId === requestId) {
      if (old.action !== action || !current(agent, old)) throw new Error("Operation scope changed");
      return old;
    }
    if (old && !terminal(old)) throw new Error("Agent control operation is pending");
    if (
      old?.phase === "failed" &&
      old.action === "full-reset" &&
      (action === "start" ||
        (old.errorCode === "workspace_clear_failed" && action !== "full-reset"))
    )
      throw new Error("Explicit Agent reset retry is required");
    const retain =
      old && old.computerId === agent.computerId && old.provider === agent.runtimeConfig.runtime;
    const identity = retain ? old.identity : !old ? agent.identity : undefined;
    const state: AgentControlState = {
      version: 1,
      protocolMajor: 1,
      requestId,
      workspaceId: agent.workspaceId,
      computerId: agent.computerId,
      agentId: agent.id,
      provider: agent.runtimeConfig.runtime,
      epoch: (old?.epoch ?? 0) + 1,
      action,
      phase: action === "start" ? "starting" : "stopping",
      configRevision: agentControlRevision(agent.runtimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      ...(identity ? { identity } : {}),
    };
    if (!(await this.store.replace(agent, state))) throw new Error("Agent configuration changed");
    return state;
  }

  /** Caller already holds the existing Agent runtime lock (create/update/recovery). */
  async publishStart(intent: AgentStartIntent, userId: string): Promise<void> {
    const agent = await this.authorized(userId, intent.workspaceId, intent.agentId);
    let state = agent.state;
    if (state && !terminal(state)) {
      // Recovery must never bypass a reset. Owner retry continues the same operation.
      if (state.action !== "start") throw new Error("Agent control operation is pending");
    } else if (!state || state.phase === "failed" || state.action === "stop") {
      state = await this.begin(agent, "start", intent.requestId);
    }
    await this.publishCurrent(agent.id, state.requestId, intent);
  }
  /** Config/credential changes must confirm stop before mutating configuration. */
  async publishStop(
    input: { agentId: string; workspaceId: string; requestId: string },
    userId: string,
  ) {
    const agent = await this.authorized(userId, input.workspaceId, input.agentId);
    const state = await this.begin(agent, "stop", input.requestId);
    const result = await this.drive(agent.id, state.requestId);
    if (result.phase !== "completed") throw new Error("Agent stop has not completed");
  }

  private async publishCurrent(agentId: string, requestId: string, recovery?: AgentStartIntent) {
    const agent = await this.store.get(agentId);
    const state = agent?.state;
    if (!agent || !state || state.requestId !== requestId || !current(agent, state))
      throw new Error("Agent configuration changed");
    if (state.phase === "stopping") {
      await this.api.publish(
        daemonControlChannel(state.workspaceId, state.computerId),
        encodeAgentStopIntent({ ...state, controlEpoch: state.epoch }),
      );
    } else if (state.phase === "clearing") {
      await this.api.publish(
        daemonControlChannel(state.workspaceId, state.computerId),
        encodeAgentWorkspaceResetRequest(state),
      );
    } else if (state.phase === "starting" || (state.phase === "completed" && recovery)) {
      const identity = state.identity;
      const reset =
        state.phase !== "completed" &&
        (state.action === "reset-session" || state.action === "full-reset");
      const intent: AgentStartIntent = {
        protocolMajor: 1,
        requestId,
        workspaceId: state.workspaceId,
        computerId: state.computerId,
        agentId,
        ...runtimeStartFields(agent.runtimeConfig),
        controlEpoch: state.epoch,
        ...(!reset &&
        identity?.sessionId &&
        (identity.state !== "empty" || state.phase === "completed")
          ? { sessionId: identity.sessionId }
          : {}),
        ...(recovery
          ? {
              wakeMessage: recovery.wakeMessage,
              resumeMessages: recovery.resumeMessages,
              unreadSummary: recovery.unreadSummary,
            }
          : {}),
      };
      const selected = this.sessions ? await this.sessions.prepare(intent) : intent;
      await this.api.publish(
        daemonControlChannel(state.workspaceId, state.computerId),
        encodeAgentStartIntent(selected),
      );
    }
  }
  private async drive(agentId: string, requestId: string): Promise<AgentControlView> {
    const deadline = Date.now() + this.timing.timeoutMs;
    let publishedPhase = "";
    for (;;) {
      const agent = await this.store.get(agentId);
      const state = agent?.state;
      if (!agent || !state || state.requestId !== requestId || !current(agent, state))
        throw new Error("Agent operation scope changed");
      if (terminal(state)) return view(state);
      if (state.phase === "stopped" || state.phase === "workspace-reset") {
        await this.advance(agentId, requestId);
        continue;
      }
      if (publishedPhase !== state.phase) {
        // Publish failure is ambiguous: keep the durable pending state and retry the SAME request.
        try {
          await this.publishCurrent(agentId, requestId);
        } catch {
          return view(state);
        }
        publishedPhase = state.phase;
        continue;
      }
      if (Date.now() >= deadline) return view(state);
      await this.timing.wait();
    }
  }

  /** Register a launch before minting its credential; never accepts user-selected Session IDs. */
  async authorizeLaunch(input: {
    agentId: string;
    workspaceId: string;
    computerId: string;
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
  }) {
    const agent = await this.store.get(input.agentId);
    if (!agent || agent.workspaceId !== input.workspaceId || agent.computerId !== input.computerId)
      throw new Error("Agent launch is not authorized");
    const state = agent.state;
    if (!state) {
      if (input.controlEpoch || input.requestId || input.launchId)
        throw new Error("Unsolicited managed launch");
      return;
    }
    if (
      !current(agent, state) ||
      state.phase !== "starting" ||
      state.requestId !== input.requestId ||
      state.epoch !== input.controlEpoch ||
      !input.launchId ||
      (state.launchId && state.launchId !== input.launchId)
    )
      throw new Error("Stale Agent launch");
    if (!(await this.store.replace(agent, { ...state, launchId: input.launchId })))
      throw new Error("Agent launch lost its fence");
  }
  /** RPC ACK follows conditional persistence; never acquires the control waiter's lock. */
  async result(claim: { workspaceId: string; computerId: string }, result: AgentControlResult) {
    const agent = await requireCurrentAgentScope(this.store, claim, result);
    const state = agent.state;
    if (result.sequence <= state.controlSequence) return;
    const command = Object.values(commands).find((command) => command.result === result.phase);
    if (command && state.phase !== command.pending) throw new Error("Unexpected command result");
    if (result.phase === "started" && (!result.launchId || state.launchId !== result.launchId))
      throw new Error("Unexpected launch result");
    if (terminal(state)) throw new Error("Operation already finished");
    if (result.phase === "workspace-reset" && result.identity)
      throw new Error("Reset retained old Session");
    const { identity: oldIdentity, errorCode: _oldError, ...fields } = state;
    const identity =
      result.phase === "started" && state.sessionSequence > result.sequence
        ? oldIdentity
        : (result.identity ?? oldIdentity);
    const identityChanged =
      result.phase === "started" &&
      !!oldIdentity?.sessionId &&
      !!result.identity?.sessionId &&
      oldIdentity.sessionId !== result.identity.sessionId;
    if (identityChanged && state.launchIdentityBound)
      throw new Error("Native Session identity changed during launch");
    const next: AgentControlState = {
      ...fields,
      controlSequence: result.sequence,
      phase: command?.completed ?? "failed",
      ...(result.phase === "started" && result.identity ? { launchIdentityBound: true } : {}),
      ...(state.recovered || (identityChanged && oldIdentity?.state !== "empty")
        ? { recovered: true }
        : {}),
      ...(identity ? { identity } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    };
    if (!(await this.store.replace(agent, next))) throw new Error("Control result lost its fence");
    if (next.phase === "stopped" || next.phase === "workspace-reset")
      await this.advance(agent.id, next.requestId).catch(() => {});
  }
}
