import type { Prisma } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

/**
 * An `Agent` row that has not been deleted. `deletedAt` is the delete marker: an
 * Agent row can never be hard-deleted once it owns a Message, Task or Action card
 * (`Message.sender`, `Task.creator`/`owner` and `ActionCard.preparedByAgent` are
 * `onDelete: Restrict`), so "is this Agent currently live" must always be spelled with this
 * filter rather than by row existence alone — the same shape `ACTIVE_MEMBER_WHERE` already
 * established for channel membership.
 *
 * A deleted Agent keeps its Messages and Tasks so history stays readable, but is hidden from
 * every directory, list, wake, control and profile lookup, and can never mint another Agent API
 * key. Read the raw row (without this filter) only from the deletion module itself and from the
 * message projections that render a deleted sender.
 */
export const ACTIVE_AGENT_WHERE = { deletedAt: null } satisfies Prisma.AgentWhereInput;

/**
 * Refuse a mutation aimed at a deleted Agent. The filter above hides a deleted Agent
 * from live *reads*; this is the matching guard for *writes* and control, which must resolve the
 * raw row first (recovery has to observe a deleted Agent to reconcile a process the Daemon still
 * reports as running). One owner of the refusal keeps the answer consistent: every caller that
 * reaches one by id answers the same `NOT_FOUND` a live-view lookup would, instead of leaking a
 * generic 500 or an authorization-shaped error.
 *
 * Callers are the paths that could otherwise start or rewrite a deleted Agent: `AgentControl`
 * (execute/publishStart/recover), `ManageAgents.update`, `AgentEnvironment.save` and
 * `ChangeAgentRuntimeCredential`. `deletedAt` is optional so both the raw Prisma row and the
 * `AgentRecord` projection (where absence means "not deleted") satisfy it.
 */
export function assertAgentLive(agent: { deletedAt?: Date | null }): void {
  if (agent.deletedAt) throw new AppError("NOT_FOUND");
}
