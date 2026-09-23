import { z } from "zod";
import { RUNTIME_PROVIDER_VALUES } from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import type {
  AgentControlAgent,
  AgentControlState,
  AgentControlStore,
} from "#src/server/agents/agent-control.server";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

const stateSchema = z
  .object({
    version: z.literal(1),
    protocolMajor: z.literal(1),
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
    computerId: z.string().min(1),
    agentId: z.string().min(1),
    provider: z.enum(RUNTIME_PROVIDER_VALUES),
    epoch: z
      .number()
      .int()
      .positive()
      .max(2 ** 31 - 1),
    action: z.enum(["start", "stop", "restart", "reset-session", "full-reset"]),
    phase: z.enum([
      "stopping",
      "stopped",
      "clearing",
      "workspace-reset",
      "starting",
      "completed",
      "failed",
    ]),
    configRevision: z.string(),
    launchId: z.string().optional(),
    launchIdentityBound: z.boolean().optional(),
    recovered: z.boolean().optional(),
    identity: z
      .object({ sessionId: z.string(), state: z.enum(["empty", "resumable", "unknown"]) })
      .optional(),
    controlSequence: z.number().int().nonnegative(),
    sessionSequence: z.number().int().nonnegative(),
    errorCode: z.string().optional(),
    /** Legacy field, since removed (latest command wins, no abandonment).
     * Accepted here only so a row persisted before this change still parses; ignored by every
     * reader and never written by `controlState()` below, since `AgentControlState` no longer
     * has this field at the TypeScript level. */
    updatedAtMs: z.number().nonnegative().optional(),
  })
  .strict();

/** The clean shape written to `controlState` and handed to the rest of the application —
 * `identity` lives in the Session table, and any legacy `updatedAtMs` a parsed row carried is
 * dropped by construction (`stateSchema.parse` output is spread into `AgentControlState`, which
 * has no such field, so pulling only the named keys below can never reintroduce it). */
function controlState(state: AgentControlState) {
  const { identity: _identity, ...control } = stateSchema.parse(state);
  return control;
}

/** Session rows own native identity; Agent JSONB owns only the current control fence. */
export class PrismaAgentControlStore implements AgentControlStore {
  constructor(private readonly db: PrismaClient) {}
  async get(agentId: string): Promise<AgentControlAgent | undefined> {
    const agent = await this.db.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        ownerId: true,
        workspaceId: true,
        computerId: true,
        visibility: true,
        runtimeConfig: true,
        runtimeSession: true,
        controlState: true,
        stoppedAt: true,
        deletedAt: true,
        currentSessionId: true,
        currentSession: true,
        owner: { select: { memberships: { select: { workspaceId: true } } } },
        computer: { select: { workspaces: { select: { workspaceId: true } } } },
      },
    });
    if (
      !agent?.computerId ||
      !agent.owner.memberships.some((m) => m.workspaceId === agent.workspaceId) ||
      !agent.computer?.workspaces.some((w) => w.workspaceId === agent.workspaceId)
    )
      return undefined;
    // `updatedAtMs` (legacy, ignored, never written — see `stateSchema`) is dropped here so it
    // never reaches `AgentControlState`/the rest of the application, even for a row persisted
    // before the field was removed. `storedControlState` below keeps the raw, unstripped
    // JSON for `replace()`'s compare-and-swap predicate, so a legacy row's extra key does not
    // make that predicate lose against the real stored value.
    const state =
      agent.controlState === null
        ? null
        : (({ updatedAtMs: _updatedAtMs, ...rest }) => rest)(stateSchema.parse(agent.controlState));
    const session = agent.currentSession;
    if (session && (session.agentId !== agent.id || session.workspaceId !== agent.workspaceId))
      throw new Error("Agent Session association is invalid");
    const identity =
      session?.nativeSessionId &&
      ((state && session.provider === state.provider && session.computerId === state.computerId) ||
        (!state &&
          session.provider === parseAgentRuntimeConfig(agent.runtimeConfig).runtime &&
          session.computerId === agent.computerId))
        ? {
            sessionId: session.nativeSessionId,
            state: z.enum(["empty", "unknown", "resumable"]).parse(session.state),
          }
        : undefined;
    if (state && identity) state.identity = identity;
    return {
      id: agent.id,
      ownerId: agent.ownerId,
      workspaceId: agent.workspaceId,
      computerId: agent.computerId,
      visibility: agent.visibility,
      runtimeConfig: parseAgentRuntimeConfig(agent.runtimeConfig),
      storedRuntimeConfig: agent.runtimeConfig,
      storedRuntimeSession: agent.runtimeSession,
      storedControlState: agent.controlState,
      currentSessionId: agent.currentSessionId,
      stoppedAt: agent.stoppedAt,
      deletedAt: agent.deletedAt,
      state,
      ...(identity ? { identity } : {}),
    };
  }
  async replace(
    before: AgentControlAgent,
    state: AgentControlState,
    options?: { clearSession?: boolean; stoppedAt?: Date | null },
  ) {
    const checked = stateSchema.parse(state);
    return this.db.$transaction(async (tx) => {
      // Lock Agent first, then read its related Session in a fresh READ COMMITTED
      // statement. A joined UPDATE predicate can otherwise observe an old Session.
      await tx.$queryRaw`SELECT id FROM agents WHERE id = ${before.id}::uuid FOR UPDATE`;
      const locked = await tx.agent.findUnique({
        where: { id: before.id },
        select: { currentSessionId: true, currentSession: true },
      });
      const session = locked?.currentSession;
      const scoped =
        session?.provider === (before.state?.provider ?? before.runtimeConfig.runtime) &&
        session.computerId === (before.state?.computerId ?? before.computerId);
      if (
        !locked ||
        locked.currentSessionId !== (before.currentSessionId ?? null) ||
        (scoped ? (session.nativeSessionId ?? undefined) : undefined) !==
          before.identity?.sessionId ||
        (before.identity && session?.state !== before.identity.state)
      )
        return false;
      const clearSession = options?.clearSession === true;
      const changedRequest = before.state?.requestId !== checked.requestId;
      const result = await tx.agent.updateMany({
        where: {
          id: before.id,
          ownerId: before.ownerId,
          workspaceId: before.workspaceId,
          computerId: before.computerId,
          currentSessionId: before.currentSessionId ?? null,
          ...(before.identity
            ? {
                currentSession: {
                  is: {
                    agentId: before.id,
                    workspaceId: before.workspaceId,
                    computerId: before.state?.computerId ?? before.computerId,
                    provider: before.state?.provider ?? before.runtimeConfig.runtime,
                    nativeSessionId: before.identity.sessionId,
                    state: before.identity.state,
                  },
                },
              }
            : {}),
          owner: { memberships: { some: { workspaceId: before.workspaceId } } },
          computer: { workspaces: { some: { workspaceId: before.workspaceId } } },
          runtimeConfig: {
            equals: (before.storedRuntimeConfig ?? before.runtimeConfig) as Prisma.InputJsonValue,
          },
          runtimeSession: {
            equals:
              before.storedRuntimeSession == null
                ? Prisma.DbNull
                : (before.storedRuntimeSession as Prisma.InputJsonValue),
          },
          // Compare against the raw stored JSON (`storedControlState`), not a value reconstructed
          // from `before.state` (`controlState(before.state)`): a legacy row can still carry an
          // `updatedAtMs` key `before.state` never reflects, and Postgres JSONB `=` is structural
          // — an extra key would make a reconstructed predicate lose the CAS against every
          // legacy row.
          controlState: {
            equals:
              before.storedControlState == null
                ? Prisma.DbNull
                : (before.storedControlState as Prisma.InputJsonValue),
          },
        },
        data: {
          controlState: controlState(checked),
          ...(clearSession || changedRequest ? { runtimeSession: Prisma.DbNull } : {}),
          ...(clearSession ? { currentSessionId: null } : {}),
          // Last-writer-wins, not part of the CAS predicate above — the caller already
          // decided this write is safe to make in the same statement as the control state.
          ...(options?.stoppedAt !== undefined ? { stoppedAt: options.stoppedAt } : {}),
        },
      });
      if (result.count !== 1) return false;
      let sessionId = before.currentSessionId ?? null;
      const incompatible =
        before.state &&
        (before.state.provider !== checked.provider ||
          before.state.computerId !== checked.computerId);
      if (clearSession || incompatible) sessionId = null;
      if (!sessionId && (checked.phase === "starting" || checked.identity)) {
        const session = await tx.agentSession.create({
          data: {
            agentId: before.id,
            workspaceId: before.workspaceId,
            computerId: before.computerId,
            provider: checked.provider,
          },
        });
        sessionId = session.id;
      }
      if (checked.identity && sessionId) {
        let saved = await tx.agentSession.updateMany({
          where: {
            id: sessionId,
            agentId: before.id,
            workspaceId: before.workspaceId,
            computerId: checked.computerId,
            provider: checked.provider,
            OR: [{ nativeSessionId: null }, { nativeSessionId: checked.identity.sessionId }],
          },
          data: { nativeSessionId: checked.identity.sessionId, state: checked.identity.state },
        });
        if (saved.count !== 1) {
          const newLaunchIdentity =
            checked.launchIdentityBound === true && before.state?.launchIdentityBound !== true;
          if (!newLaunchIdentity) throw new Error("Native Session identity changed");
          const session = await tx.agentSession.create({
            data: {
              agentId: before.id,
              workspaceId: before.workspaceId,
              computerId: checked.computerId,
              provider: checked.provider,
              nativeSessionId: checked.identity.sessionId,
              state: checked.identity.state,
            },
          });
          sessionId = session.id;
          saved = { count: 1 };
        }
      }
      if (sessionId !== before.currentSessionId)
        await tx.agent.update({ where: { id: before.id }, data: { currentSessionId: sessionId } });
      return true;
    });
  }
  /** The ACTOR's own current Workspace role for execute()'s capability check. */
  async memberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | undefined> {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return membership ? (membership.role as WorkspaceMemberRole) : undefined;
  }
}
