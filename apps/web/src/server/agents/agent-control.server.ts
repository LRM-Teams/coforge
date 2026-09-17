import {
  encodeAgentWorkspaceResetRequest,
  encodeAgentStartIntent,
  encodeAgentStopIntent,
  type AgentControlResult,
  type AgentControlScope,
  type AgentStartIntent,
  type SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import { daemonControlChannel, type CentrifugoServerApi } from "../centrifugo/server-api.server";
import type { AgentRuntimeConfig } from "./agent-runtime-config.server";
import { runtimeStartFields } from "./manage-agents.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import type { AgentSessions } from "./agent-sessions.server";
import { LocalAgentControlSignal, type AgentControlSignal } from "./agent-control-signal.server";
import {
  assertHasAgentControlCapability,
  type AgentControlCapability,
  type WorkspaceMemberRole,
} from "../workspaces/member-role.server";

/** Only the recovery fields a Start intent may carry; a full `AgentStartIntent` (e.g.
 * `recover()`'s) structurally satisfies this too. */
type AgentRecoveryFields = Pick<
  AgentStartIntent,
  "wakeMessage" | "resumeMessages" | "unreadSummary"
>;
/** Reads the surfaced-while-stopped recovery context for a user-initiated Start (ADR 0038); the
 * same shape `WorkspaceAgentRecovery.recoverWorkspace` reads for Daemon-ready recovery. */
export type AgentControlRecoveryReader = {
  readAgentRecoveryContext(workspaceId: string, agentId: string): Promise<AgentRecoveryFields>;
};

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
/** Raft capability required for each user-initiated execute() action. Start and Stop need only
 * `controlAgentRuntime` (ADR 0038), the same as Restart and Reset session. */
const EXECUTE_CAPABILITY: Record<AgentControlAction, AgentControlCapability> = {
  start: "controlAgentRuntime",
  stop: "controlAgentRuntime",
  restart: "controlAgentRuntime",
  "reset-session": "controlAgentRuntime",
  "full-reset": "resetAgentWorkspace",
};
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
  /** Opaque persisted `controlState` JSON exactly as stored, used only for compare-and-swap.
   * A legacy row may still carry a `updatedAtMs` key that `state` below never reflects (ADR
   * 0039); using this raw value keeps the CAS predicate matching the real row instead of losing
   * every compare-and-swap against it. */
  storedControlState?: unknown;
  state: AgentControlState | null;
  currentSessionId?: string | null;
  identity?: SessionIdentity;
  /** Set when a user stopped this Agent (ADR 0038); read model only, not part of the CAS fence. */
  stoppedAt?: Date | null;
};
/** get/replace both require current owner membership and Workspace–Computer assignment. */
export interface AgentControlStore {
  get(agentId: string): Promise<AgentControlAgent | undefined>;
  /** Clear Session, when requested, commits in the same transaction as the next phase. Setting
   * `stoppedAt` (ADR 0038) writes the Agent's persisted stop/start intent in that same
   * transaction; `undefined` leaves it unchanged. This flag is last-writer-wins, not part of the
   * optimistic-concurrency fence `replace` already applies to `controlState`. */
  replace(
    before: AgentControlAgent,
    state: AgentControlState,
    options?: { clearSession?: boolean; stoppedAt?: Date | null },
  ): Promise<boolean>;
  /** The ACTOR's current Workspace role; undefined when the actor is not a member. Used only by
   * execute()'s capability check, never by the Agent-record authorization above. */
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | undefined>;
}
export type AgentControlView = {
  requestId: string;
  action: AgentControlAction;
  /** `"superseded"` (ADR 0039) is a view-only outcome: the driven request was replaced by a
   * newer command on the same Agent before it reached a terminal phase. It is never a persisted
   * `AgentControlState.phase` — only ever synthesized by `drive()` for the caller that lost the
   * race. */
  phase: "pending" | "completed" | "failed" | "superseded";
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
/** The view `drive()` returns to the caller whose request was superseded by a newer command on
 * the same Agent, instead of the "Agent operation scope changed" throw a genuine scope change
 * (Agent moved Computer, config revision changed, Agent gone) still produces. */
function supersededView(state: AgentControlState): AgentControlView {
  return { requestId: state.requestId, action: state.action, phase: "superseded" };
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

function operationFence(state: AgentControlState | null) {
  if (!state) return null;
  const {
    identity: _identity,
    sessionSequence: _sessionSequence,
    launchIdentityBound: _launchIdentityBound,
    recovered: _recovered,
    ...fence
  } = state;
  return fence;
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
    private readonly timing: {
      timeoutMs: number;
      fallbackMs?: number;
      /** Injected so `execute()`'s `stoppedAt` timestamp (ADR 0038) is deterministic in tests;
       * defaults to the real clock. No longer drives any abandonment/pending decision — ADR 0039
       * removed that concept entirely. */
      now?: () => number;
    } = { timeoutMs: 7_000 },
    private readonly sessions?: AgentSessions,
    private readonly signal: AgentControlSignal = new LocalAgentControlSignal(),
    /** Only consulted for a user-initiated `execute({action:"start"})`; Restart/Reset/Full reset
     * and the internal `recover`/`publishStart` paths are unchanged (ADR 0038). */
    private readonly conversations?: AgentControlRecoveryReader,
  ) {}

  private clock(): number {
    return (this.timing.now ?? Date.now)();
  }

  /**
   * Ready recovery republishes the current fence; it never waits for buffered daemon ACKs.
   *
   * A non-terminal state is deliberately republished here, never superseded: `recover` only
   * runs for an Agent the Daemon just reported as NOT running, so there is no risk of a
   * duplicate live process, and the Daemon's own control record repair (ADR 0033) now answers a
   * request it previously rejected outright instead of leaving it unanswered forever. Minting a
   * fresh epoch on every reconnect would instead churn the request — and republish a brand new
   * Start — on every single `ready()` for an Agent whose Daemon keeps reconnecting without ever
   * answering, without the Daemon ever getting a chance to answer the one it already has.
   * `begin` (ADR 0039) supersedes on any *owner-initiated* retry through
   * `execute`/`publishStart`/`publishStop`, unconditionally — `recover` is the one path that
   * still only republishes.
   */
  async recover(intent: AgentStartIntent, userId: string) {
    const agent = await this.authorized(userId, intent.workspaceId, intent.agentId);
    if (agent.state && !terminal(agent.state)) {
      await this.advance(agent.id, agent.state.requestId, intent);
      return;
    }
    const state = await this.begin(agent, "start", intent.requestId);
    await this.publishCurrent(agent.id, state.requestId, intent);
  }
  private async advance(agentId: string, requestId: string, recovery?: AgentRecoveryFields) {
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
    // Reaching this line without a store write above (phase already "starting"/"completed") is
    // a pure republish of the same command.
    await this.publishCurrent(agentId, requestId, recovery);
  }
  async execute(input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    requestId: string;
    action: AgentControlAction;
    confirmed?: boolean;
  }): Promise<AgentControlView> {
    if (input.action === "full-reset" && input.confirmed !== true)
      throw new Error("Full reset confirmation is required");
    // ADR 0038: `stop` persists the user's stop intent before the chain runs at all, so it
    // survives even if the Computer never answers; every other action clears it first. Messages
    // that arrived while stopped are surfaced only for the explicit "start" action, the same
    // recovery context a Daemon-ready recovery start carries.
    const stoppedAt = input.action === "stop" ? new Date(this.clock()) : null;
    const recovery =
      input.action === "start" && this.conversations
        ? await this.conversations.readAgentRecoveryContext(input.workspaceId, input.agentId)
        : undefined;
    await this.runtimeLock.run(input.agentId, async () => {
      const agent = await this.authorizedForExecute(
        input.userId,
        input.workspaceId,
        input.agentId,
        input.action,
      );
      await this.begin(agent, input.action, input.requestId, 1, stoppedAt);
    });
    return this.drive(input.agentId, input.requestId, recovery);
  }
  private async authorized(userId: string, workspaceId: string, agentId: string) {
    const agent = await this.store.get(agentId);
    if (!agent || agent.ownerId !== userId || agent.workspaceId !== workspaceId)
      throw new Error("Agent is not authorized or assigned");
    return agent;
  }
  /**
   * execute() is the only user-initiated control path; it authorizes by the actor's current
   * Workspace membership and Raft capability, not by Agent ownership (`authorized()` above,
   * still used unchanged by recover/publishStart/publishStop).
   */
  private async authorizedForExecute(
    userId: string,
    workspaceId: string,
    agentId: string,
    action: AgentControlAction,
  ) {
    const agent = await this.store.get(agentId);
    if (!agent || agent.workspaceId !== workspaceId)
      throw new Error("Agent is not authorized or assigned");
    const role = await this.store.memberRole(workspaceId, userId);
    if (!role) throw new Error("Agent is not authorized or assigned");
    assertHasAgentControlCapability(role, EXECUTE_CAPABILITY[action]);
    return agent;
  }
  private async begin(
    agent: AgentControlAgent,
    action: AgentControlAction,
    requestId: string,
    attempt = 1,
    /** ADR 0038: `undefined` leaves the Agent's persisted stopped state unchanged (every caller
     * except `execute()` — `recover`, and `begin`'s own CAS retries, must never touch it). */
    stoppedAt?: Date | null,
  ): Promise<AgentControlState> {
    const old = agent.state;
    if (old?.requestId === requestId) {
      if (old.action !== action || !current(agent, old)) throw new Error("Operation scope changed");
      return old;
    }
    // Latest command wins (ADR 0039): a different requestId always supersedes whatever the
    // current state is — terminal or not, any action, any phase (including a Full Reset caught
    // mid `clearing`) — exactly the same shape a terminal `old` was already superseded with:
    // epoch + 1, identity retained by the existing `computerId`/`provider` rule, `launchId`/
    // `launchIdentityBound` dropped because the new `state` literal never copies them forward.
    // Raft Computer 1.0.32 keeps no operation-in-progress record at all — a newer start/stop/
    // reset simply takes effect and epochs only cancel superseded work — so there is neither a
    // "pending" rejection nor an "abandoned" concept to approximate here; supersede is normal
    // behaviour, logged at info, once per occurrence.
    if (old)
      console.info(
        JSON.stringify({
          event: "agent_control:operation_superseded",
          agent_id: agent.id,
          workspace_id: agent.workspaceId,
          computer_id: agent.computerId,
          previous_action: old.action,
          previous_phase: old.phase,
          previous_epoch: old.epoch,
          previous_request_id: old.requestId,
          new_action: action,
          request_id: requestId,
          outcome: "superseded",
        }),
      );
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
    if (await this.store.replace(agent, state, stoppedAt !== undefined ? { stoppedAt } : undefined))
      return state;

    // Session reports do not take the runtime lock. Reauthorize and rebuild from
    // their fresh identity, but never absorb a configuration or operation change.
    const refreshed = await this.authorized(agent.ownerId, agent.workspaceId, agent.id);
    if (
      refreshed.computerId !== agent.computerId ||
      !Bun.deepEquals(refreshed.runtimeConfig, agent.runtimeConfig, true) ||
      !Bun.deepEquals(
        refreshed.storedRuntimeConfig ?? refreshed.runtimeConfig,
        agent.storedRuntimeConfig ?? agent.runtimeConfig,
        true,
      ) ||
      !Bun.deepEquals(operationFence(refreshed.state), operationFence(old), true) ||
      (refreshed.state?.sessionSequence ?? 0) < (old?.sessionSequence ?? 0)
    )
      throw new Error("Agent configuration or control operation changed");
    if (attempt === 3)
      throw new Error("Agent control could not begin after 3 compare-and-swap attempts");
    return this.begin(refreshed, action, requestId, attempt + 1, stoppedAt);
  }

  /** Caller already holds the existing Agent runtime lock (create/update/recovery). */
  async publishStart(intent: AgentStartIntent, userId: string): Promise<void> {
    const agent = await this.authorized(userId, intent.workspaceId, intent.agentId);
    let state = agent.state;
    if (state && !terminal(state)) {
      // A Start already in flight for the same purpose (recovery, another config-triggered
      // publishStart) continues rather than restarting the launch from scratch; anything else —
      // a Stop, Restart, Reset session or Full reset still in flight — is an explicit command
      // superseding another explicit command, so it always supersedes (ADR 0039 rule 1); `begin`
      // no longer throws "pending" for this.
      if (state.action !== "start") state = await this.begin(agent, "start", intent.requestId);
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
    if (result.phase !== "completed")
      throw new Error(
        result.phase === "superseded"
          ? "Agent stop was superseded by a newer command before it completed"
          : "Agent stop has not completed",
      );
  }

  private async publishCurrent(agentId: string, requestId: string, recovery?: AgentRecoveryFields) {
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
  private async drive(
    agentId: string,
    requestId: string,
    /** Only ever set by `execute()`'s `"start"` action; threaded into the single `publishCurrent`
     * call this method itself makes (ADR 0038). Chain transitions still go through `advance()`,
     * unchanged, exactly as an owner-initiated Restart/Reset/Full reset already did. */
    recovery?: AgentRecoveryFields,
  ): Promise<AgentControlView> {
    const deadline = Date.now() + this.timing.timeoutMs;
    let publishedPhase = "";
    // A signal means the ACK handler already advanced and published the next command.
    let signaled = false;
    for (;;) {
      const agent = await this.store.get(agentId);
      const state = agent?.state;
      // A genuine scope change (Agent moved Computer, config revision changed, Agent gone) is
      // still an error; a requestId that changed while the Agent's own scope is still current
      // means a newer command superseded this one (ADR 0039) — report that to the caller
      // instead of an error, since the newer command is the one actually running now.
      if (!agent || !state || !current(agent, state))
        throw new Error("Agent operation scope changed");
      if (state.requestId !== requestId) return supersededView(state);
      if (terminal(state)) return view(state);
      if (state.phase === "stopped" || state.phase === "workspace-reset") {
        await this.advance(agentId, requestId);
        continue;
      }
      if (signaled) {
        signaled = false;
        publishedPhase = state.phase;
      }
      if (publishedPhase !== state.phase) {
        // Publish failure is ambiguous: keep the durable pending state and retry the SAME
        // request, UNLESS the failure happened because the request was superseded underneath us
        // in the meantime — re-read to tell the two apart instead of reporting the stale phase.
        try {
          await this.publishCurrent(agentId, requestId, recovery);
        } catch {
          const latest = await this.store.get(agentId);
          const latestState = latest?.state;
          if (
            latest &&
            latestState &&
            latestState.requestId !== requestId &&
            current(latest, latestState)
          )
            return supersededView(latestState);
          return view(state);
        }
        publishedPhase = state.phase;
        continue;
      }
      if (Date.now() >= deadline) return view(state);
      // Daemon ACKs wake the waiter; the fallback re-read bounds a lost signal.
      signaled = await this.signal.wait(
        agentId,
        Math.min(this.timing.fallbackMs ?? 1_000, deadline - Date.now()),
      );
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
    if (next.phase === "stopped" || next.phase === "workspace-reset") {
      // Publish failure stays silent so the waiter's fallback re-read republishes the phase.
      const advanced = await this.advance(agent.id, next.requestId).then(
        () => true,
        () => false,
      );
      if (!advanced) return;
    }
    await this.signal.notify(agent.id).catch(() => {});
  }
}
