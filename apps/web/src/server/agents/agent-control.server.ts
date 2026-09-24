import {
  encodeAgentWorkspaceResetRequest,
  encodeAgentStartIntent,
  encodeAgentStopIntent,
  type AgentControlResult,
  type AgentControlScope,
  type AgentStartIntent,
  type SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import type { AgentRuntimeConfig } from "./agent-runtime-config.server";
import { runtimeStartFields } from "./manage-agents.server";
import { assertAgentLive } from "./active-agent.server";
import { AppError } from "#src/lib/app-error";
import { canSeeAgent } from "./agent-visibility.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import type { AgentSessions } from "./agent-sessions.server";
import { LocalAgentControlSignal, type AgentControlSignal } from "./agent-control-signal.server";
import {
  assertHasAgentControlCapability,
  type AgentControlCapability,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

/** Only the recovery fields a Start intent may carry; a full `AgentStartIntent` (e.g.
 * `recover()`'s) structurally satisfies this too. */
type AgentRecoveryFields = Pick<
  AgentStartIntent,
  "wakeMessage" | "resumeMessages" | "unreadSummary"
>;
/** Reads the surfaced-while-stopped recovery context for a user-initiated Start; the
 * same shape `WorkspaceAgentRecovery.recoverWorkspace` reads for Daemon-ready recovery. */
export type AgentControlRecoveryReader = {
  readAgentRecoveryContext(workspaceId: string, agentId: string): Promise<AgentRecoveryFields>;
};

/** Application button intent; never sent as a daemon command. */
export type AgentControlAction = "start" | "stop" | "restart" | "reset-session" | "full-reset";
type AgentControlStep = "stop" | "reset-workspace" | "clear-session" | "start";
/** Whether a Start intent already brings unread-message recovery of its own. */
function carriesRecovery(intent: AgentRecoveryFields): boolean {
  return Boolean(
    intent.wakeMessage ||
    intent.resumeMessages?.length ||
    Object.keys(intent.unreadSummary ?? {}).length,
  );
}
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
/** How many Agents `stopMany` stops at once: each holds a runtime-lock connection and a
 * transaction, and both pools default to 10 connections for the whole process. */
const STOP_MANY_CONCURRENCY = 4;
/** Raft capability required for each user-initiated execute() action. Start and Stop need only
 * `controlAgentRuntime`, the same as Restart and Reset session. */
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
  /** Required, not defaulted: `authorizedForExecute` reads this directly with no
   * `?? "public"` fallback, so a select that ever forgot to fetch it fails a type check instead
   * of silently failing open and treating an unseen private Agent as visible. */
  visibility: string;
  runtimeConfig: AgentRuntimeConfig;
  /** Opaque persisted representation used only for compare-and-swap. */
  storedRuntimeConfig?: unknown;
  storedRuntimeSession?: unknown;
  /** Opaque persisted `controlState` JSON exactly as stored, used only for compare-and-swap.
   * A legacy row may still carry a `updatedAtMs` key that `state` below never reflects;
   * using this raw value keeps the CAS predicate matching the real row instead of losing
   * every compare-and-swap against it. */
  storedControlState?: unknown;
  state: AgentControlState | null;
  currentSessionId?: string | null;
  identity?: SessionIdentity;
  /** Set when a user stopped this Agent; read model only, not part of the CAS fence. */
  stoppedAt?: Date | null;
  /** Set when a user deleted this Agent; read model only, not part of the CAS fence.
   * The internal paths (`recover`, `publishStop`) still operate on a deleted Agent so a Stop can
   * reconcile one the Daemon still runs; the user-initiated `execute()` refuses it outright. */
  deletedAt?: Date | null;
};
/** get/replace both require current owner membership and Workspace–Computer assignment. */
export interface AgentControlStore {
  get(agentId: string): Promise<AgentControlAgent | undefined>;
  /** Clear Session, when requested, commits in the same transaction as the next phase. Setting
   * `stoppedAt` writes the Agent's persisted stop/start intent in that same
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
  /** `"superseded"` is a view-only outcome: the driven request was replaced by a
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
      /** Injected so `execute()`'s `stoppedAt` timestamp is deterministic in tests;
       * defaults to the real clock. No longer drives any abandonment/pending decision —
       * that concept was removed entirely. */
      now?: () => number;
    } = { timeoutMs: 7_000 },
    private readonly sessions?: AgentSessions,
    private readonly signal: AgentControlSignal = new LocalAgentControlSignal(),
    /** Only consulted for a user-initiated `execute({action:"start"})`; Restart/Reset/Full reset
     * and the internal `recover`/`publishStart` paths are unchanged. */
    private readonly conversations?: AgentControlRecoveryReader,
  ) {}

  /** WeeklyReportAssistant subject launches override the global current session for one start. */
  readonly #subjectSessionByRequest = new Map<
    string,
    { sessionId: string; sessionMode: "create" | "resume" }
  >();

  private clock(): number {
    return (this.timing.now ?? Date.now)();
  }

  /**
   * Ready recovery republishes the current fence; it never waits for buffered daemon ACKs.
   *
   * A non-terminal state is deliberately republished here, never superseded: `recover` only
   * runs for an Agent the Daemon just reported as NOT running, so there is no risk of a
   * duplicate live process, and the Daemon's own control record repair now answers a
   * request it previously rejected outright instead of leaving it unanswered forever. Minting a
   * fresh epoch on every reconnect would instead churn the request — and republish a brand new
   * Start — on every single `ready()` for an Agent whose Daemon keeps reconnecting without ever
   * answering, without the Daemon ever getting a chance to answer the one it already has.
   * `begin` supersedes on any *owner-initiated* retry through
   * `execute`/`publishStart`/`publishStop`, unconditionally — `recover` is the one path that
   * still only republishes.
   */
  async recover(intent: AgentStartIntent, userId: string) {
    const agent = await this.authorized(userId, intent.workspaceId, intent.agentId);
    // Recovery never starts a deleted Agent. `WorkspaceAgentRecovery` already lists
    // deleted Agents separately and stops them instead, so this is the last line of defence for a
    // Daemon `ready` that races a delete.
    assertAgentLive(agent);
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
      // A chain step that moves into "starting" (e.g. Restart's stop -> start,
      // Reset session's stop -> clear-session -> start) mints a fresh launchId here, the moment
      // of the same phase transition `begin()` mints one for a direct `action: "start"` — never
      // carried forward from the step this operation just finished.
      const launchId = next === "start" ? crypto.randomUUID() : undefined;
      if (
        !(await this.store.replace(
          agent,
          {
            ...fields,
            phase: next ? commands[next].pending : "completed",
            sessionSequence: 0,
            ...(!clearSession && identity ? { identity } : {}),
            ...(launchId ? { launchId } : {}),
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
    // `stop` persists the user's stop intent before the chain runs at all, so it
    // survives even if the Computer never answers; every other action clears it first. Messages
    // that arrived while stopped are surfaced for the explicit "start" action here, and for the
    // Start that ends a Restart or Reset in `publishCurrent`: the same recovery context a
    // Daemon-ready recovery start carries.
    const stoppedAt = input.action === "stop" ? new Date(this.clock()) : null;
    const recovery =
      input.action === "start"
        ? await this.readRecovery(input.workspaceId, input.agentId)
        : undefined;
    let drivenRequestId = input.requestId;
    await this.runtimeLock.run(input.agentId, async () => {
      const agent = await this.authorizedForExecute(
        input.userId,
        input.workspaceId,
        input.agentId,
        input.action,
      );
      // Raft: a Start that meets an Agent already starting joins that launch, it never issues
      // a second one. Superseding here would publish Start at epoch + 1 while the Daemon is
      // still launching the previous epoch; the Daemon answers that with `agent_already_running`
      // and no result, and the running launch's own `started` result and Session snapshots are
      // then stale, so the server would never learn the new Session.
      const inFlight = agent.state;
      if (
        input.action === "start" &&
        inFlight &&
        inFlight.phase === "starting" &&
        current(agent, inFlight) &&
        !agent.stoppedAt
      ) {
        drivenRequestId = inFlight.requestId;
        return;
      }
      await this.begin(agent, input.action, input.requestId, 1, stoppedAt);
    });
    return this.drive(input.agentId, drivenRequestId, recovery);
  }
  /**
   * Stops several Agents for one user at once (a channel's "Stop all Agents"): for each Agent the
   * same durable stop `execute({ action: "stop" })` writes, with the actor's role read once and at
   * most `STOP_MANY_CONCURRENCY` Agents in flight, since each holds a runtime-lock connection and
   * a transaction. The stop command is sent without waiting for the Daemon: `stoppedAt` keeps the
   * intent, and a Daemon that reconnects still running the Agent is stopped by ready recovery. A
   * command that cannot be sent is tried once more; if it still fails the Agent is reported as not
   * stopped, and its operation stays "stopping" so a later stop sends it again.
   */
  async stopMany(input: {
    userId: string;
    workspaceId: string;
    agentIds: readonly string[];
  }): Promise<{ agentId: string; stopped: boolean }[]> {
    const role = await this.actorRole(input.workspaceId, input.userId, "stop");
    const stoppedAt = new Date(this.clock());
    const stopOne = async (agentId: string) => {
      try {
        const state = await this.runtimeLock.run(agentId, async () => {
          const agent = await this.controllableAgent(
            agentId,
            input.workspaceId,
            input.userId,
            role,
          );
          return this.begin(agent, "stop", crypto.randomUUID(), 1, stoppedAt);
        });
        await this.sendStop(state).catch(() => this.sendStop(state));
        return { agentId, stopped: true };
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "agent_control:stop_many_failed",
            agent_id: agentId,
            workspace_id: input.workspaceId,
            error_type: error instanceof Error ? error.name : typeof error,
          }),
        );
        return { agentId, stopped: false };
      }
    };
    const results: { agentId: string; stopped: boolean }[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(STOP_MANY_CONCURRENCY, input.agentIds.length) }, async () => {
        while (next < input.agentIds.length) {
          const index = next++;
          results[index] = await stopOne(input.agentIds[index]!);
        }
      }),
    );
    return results;
  }
  private async authorized(userId: string, workspaceId: string, agentId: string) {
    const agent = await this.store.get(agentId);
    if (!agent || agent.ownerId !== userId || agent.workspaceId !== workspaceId)
      throw new Error("Agent is not authorized or assigned");
    return agent;
  }
  /**
   * execute() and stopMany() are the user-initiated control paths; they authorize by the actor's
   * current Workspace membership and Agent-control capability, not by Agent ownership (`authorized()`
   * above, still used unchanged by recover/publishStart/publishStop).
   */
  private async authorizedForExecute(
    userId: string,
    workspaceId: string,
    agentId: string,
    action: AgentControlAction,
  ) {
    const role = await this.actorRole(workspaceId, userId, action);
    return this.controllableAgent(agentId, workspaceId, userId, role);
  }
  private async actorRole(workspaceId: string, userId: string, action: AgentControlAction) {
    const role = await this.store.memberRole(workspaceId, userId);
    if (!role) throw new Error("Agent is not authorized or assigned");
    assertHasAgentControlCapability(role, EXECUTE_CAPABILITY[action]);
    return role;
  }
  private async controllableAgent(
    agentId: string,
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ) {
    const agent = await this.store.get(agentId);
    if (!agent || agent.workspaceId !== workspaceId)
      throw new Error("Agent is not authorized or assigned");
    // A deleted Agent has no user-initiated control surface at all — not even Start.
    // Only the internal `recover`/`publishStop` paths may still touch one, to reconcile a process
    // the Daemon reports as running.
    assertAgentLive(agent);
    // "any current member may control" stops at a private Agent the actor cannot see —
    // the same absent shape every other visibility failure uses, never a detail leak. Owner/admin
    // always passes (`canSeeAgent`'s elevated-role branch), matching the visibility rule's one
    // carve-out that manage authority does not itself grant DM/open access.
    if (!canSeeAgent({ kind: "user", userId, role }, agent)) throw new AppError("NOT_FOUND");
    return agent;
  }
  private async begin(
    agent: AgentControlAgent,
    action: AgentControlAction,
    requestId: string,
    attempt = 1,
    /** `undefined` leaves the Agent's persisted stopped state unchanged (every caller
     * except `execute()` — `recover`, and `begin`'s own CAS retries, must never touch it). */
    stoppedAt?: Date | null,
  ): Promise<AgentControlState> {
    const old = agent.state;
    if (old?.requestId === requestId) {
      if (old.action !== action || !current(agent, old)) throw new Error("Operation scope changed");
      return old;
    }
    // Latest command wins: a different requestId always supersedes whatever the
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
    // The server mints one launchId per operation's start step, the moment the
    // operation enters phase "starting", in this same compare-and-swap write — never later, and
    // never re-minted for a republish of the same operation (`state.requestId === requestId`
    // stays idempotent above and never reaches here; `advance()` mints its own when a chain's
    // stop/clear steps finish and it moves into "starting"). The Daemon no longer mints its own.
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
      ...(action === "start" ? { launchId: crypto.randomUUID() } : {}),
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
    // A deleted Agent is never started again. Every configuration, credential and
    // environment mutation funnels its restart through here, so this is the one place that has to
    // hold; `execute()` refuses it earlier, with a user-facing message.
    assertAgentLive(agent);
    let state = agent.state;
    let began = false;
    if (state && !terminal(state)) {
      // A Start already in flight for the same purpose (recovery, another config-triggered
      // publishStart) continues rather than restarting the launch from scratch; anything else —
      // a Stop, Restart, Reset session or Full reset still in flight — is an explicit command
      // superseding another explicit command, so it always supersedes; `begin`
      // no longer throws "pending" for this.
      if (state.action !== "start") {
        state = await this.begin(agent, "start", intent.requestId);
        began = true;
      }
    } else if (!state || state.phase === "failed" || state.action === "stop") {
      state = await this.begin(agent, "start", intent.requestId);
      began = true;
    }
    // A configuration restart stopped the Agent first, dropping what its daemon held (already
    // acknowledged), so a fresh Start that brings no recovery of its own reads the unread
    // messages, as a plain Start does. A Daemon-ready recovery Start already carries them.
    const recovery =
      began && !carriesRecovery(intent)
        ? { ...intent, ...(await this.readRecovery(intent.workspaceId, intent.agentId)) }
        : intent;
    await this.publishCurrent(agent.id, state.requestId, recovery);
  }

  /** The unread messages a Start surfaces. A failed read never blocks the Start: the Agent still
   * reaches those messages through `check`. */
  private async readRecovery(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentRecoveryFields | undefined> {
    if (!this.conversations) return undefined;
    try {
      return await this.conversations.readAgentRecoveryContext(workspaceId, agentId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_control:recovery_read_failed",
          workspace_id: workspaceId,
          agent_id: agentId,
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
      return undefined;
    }
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

  /** Native session and control phase used to decide a WeeklyReportAssistant subject switch. */
  async readLaunchPresence(input: { userId: string; workspaceId: string; agentId: string }) {
    const agent = await this.authorized(input.userId, input.workspaceId, input.agentId);
    return {
      phase: agent.state?.phase ?? null,
      action: agent.state?.action ?? null,
      sessionId: agent.identity?.sessionId ?? null,
      stoppedByUser: Boolean(agent.stoppedAt),
    };
  }

  /**
   * Start this Agent on an explicit native session and wait until the launch completes.
   * Used when a WeeklyReportAssistant wake must not resume `Agent.currentSessionId`.
   */
  async startOnSession(input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    sessionId: string;
    sessionMode: "create" | "resume";
  }): Promise<void> {
    const requestId = crypto.randomUUID();
    this.#subjectSessionByRequest.set(requestId, {
      sessionId: input.sessionId,
      sessionMode: input.sessionMode,
    });
    let drivenRequestId: string = requestId;
    try {
      await this.runtimeLock.run(input.agentId, async () => {
        const agent = await this.authorized(input.userId, input.workspaceId, input.agentId);
        assertAgentLive(agent);
        const inFlight = agent.state;
        if (
          inFlight &&
          inFlight.phase === "starting" &&
          current(agent, inFlight) &&
          agent.identity?.sessionId === input.sessionId &&
          !agent.stoppedAt
        ) {
          drivenRequestId = inFlight.requestId;
          return;
        }
        await this.begin(agent, "start", requestId, 1, null);
      });
      const result = await this.drive(input.agentId, drivenRequestId);
      if (result.phase !== "completed") throw new AppError("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#subjectSessionByRequest.delete(requestId);
    }
  }

  private sendStop(state: AgentControlState) {
    return this.api.publish(
      daemonControlChannel(state.workspaceId, state.computerId),
      encodeAgentStopIntent({ ...state, controlEpoch: state.epoch }),
    );
  }
  private async publishCurrent(agentId: string, requestId: string, recovery?: AgentRecoveryFields) {
    const agent = await this.store.get(agentId);
    const state = agent?.state;
    if (!agent || !state || state.requestId !== requestId || !current(agent, state))
      throw new Error("Agent configuration changed");
    if (state.phase === "stopping") {
      await this.sendStop(state);
    } else if (state.phase === "clearing") {
      await this.api.publish(
        daemonControlChannel(state.workspaceId, state.computerId),
        encodeAgentWorkspaceResetRequest(state),
      );
    } else if (state.phase === "starting" || (state.phase === "completed" && recovery)) {
      // A Restart or Reset ends with a Start after its stop step, which dropped what the daemon
      // held (already acknowledged). That Start carries the unread messages from the read
      // boundary, the same recovery a plain Start reads in `execute`.
      if (!recovery && state.phase === "starting" && state.action !== "start")
        recovery = await this.readRecovery(state.workspaceId, agentId);
      const identity = state.identity;
      const reset =
        state.phase !== "completed" &&
        (state.action === "reset-session" || state.action === "full-reset");
      // `launchId` should already be minted (`begin()`/`advance()`, the moment this
      // operation entered "starting"); the only gap is a "starting" row written before this
      // record shipped. Mint and persist it here, once, before publish — never for a "completed"
      // republish, which already has one from when it first started.
      let launchId = state.launchId;
      if (state.phase === "starting" && !launchId) {
        launchId = crypto.randomUUID();
        if (!(await this.store.replace(agent, { ...state, launchId }))) {
          const refreshed = await this.store.get(agentId);
          const refreshedLaunchId =
            refreshed?.state?.requestId === requestId ? refreshed.state.launchId : undefined;
          if (!refreshedLaunchId) throw new Error("Agent launch could not be assigned an id");
          launchId = refreshedLaunchId;
        }
      }
      const intent: AgentStartIntent = {
        protocolMajor: 1,
        requestId,
        workspaceId: state.workspaceId,
        computerId: state.computerId,
        agentId,
        ...runtimeStartFields(agent.runtimeConfig),
        controlEpoch: state.epoch,
        ...(launchId ? { launchId } : {}),
        ...(this.#subjectSessionByRequest.get(requestId)
          ? this.#subjectSessionByRequest.get(requestId)
          : !reset &&
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
     * call this method itself makes. Chain transitions still go through `advance()`; the Start
     * that ends a Restart/Reset/Full reset reads its own recovery in `publishCurrent`. */
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
      // means a newer command superseded this one — report that to the caller
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

  /**
   * Verifies a launch before minting its credential; never accepts user-selected Session IDs.
   *
   * `launchId` is minted and persisted by `begin()`/`advance()`/`publishCurrent()` the
   * moment the operation enters "starting" — before this is ever called. This method only
   * verifies the Daemon's claimed `launchId` matches that already-stored value; it performs no
   * write, so there is no compare-and-swap race left to retry here (a concurrent Session write,
   * e.g. an `agent:session:invalidate`-triggered clear, cannot make a read-only check lose a
   * race the way the old read-validate-write pass could).
   */
  async authorizeLaunch(input: {
    agentId: string;
    workspaceId: string;
    computerId: string;
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
  }): Promise<void> {
    const agent = await this.store.get(input.agentId);
    if (!agent || agent.workspaceId !== input.workspaceId || agent.computerId !== input.computerId)
      throw new Error("Agent launch is not authorized");
    const state = agent.state;
    if (!state) {
      if (input.controlEpoch || input.requestId || input.launchId)
        throw new Error("Unsolicited managed launch");
      return;
    }
    if (!current(agent, state)) throw new Error("Stale Agent launch");
    const sameScope =
      state.requestId === input.requestId &&
      state.epoch === input.controlEpoch &&
      !!input.launchId &&
      state.launchId === input.launchId;
    if (state.phase === "starting") {
      if (sameScope) return;
      throw new Error("Stale Agent launch");
    }
    // A daemon-initiated wake resends the same requestId/controlEpoch/launchId this
    // Agent's last managed operation completed under, instead of a fresh managed scope. Accepted
    // only when that operation finished a chain that ends in `start` under the exact same scope,
    // and the Agent is not user-stopped — never for a superseded, failed, or stopped
    // operation. A completed `stop` chain also ends in phase "completed" (`advance()` has no next
    // step); it carries no `launchId`, so `sameScope` already excludes it, but the action is
    // checked explicitly so this never depends on that.
    if (state.phase === "completed" && state.action !== "stop" && sameScope && !agent.stoppedAt)
      return;
    throw new Error("Stale Agent launch");
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
