import type { Prisma } from "../../../generated/client";

/**
 * An `Agent` row that has not been deleted (ADR 0044). `deletedAt` is the delete marker: an
 * Agent row can never be hard-deleted once it owns a Message, Task or Action card
 * (`Message.sender`, `Task.creator`/`owner` and `ActionCard.preparedByAgent` are
 * `onDelete: Restrict`), so "is this Agent currently live" must always be spelled with this
 * filter rather than by row existence alone — the same shape `ACTIVE_MEMBER_WHERE` already
 * established for channel membership (ADR 0024/0031).
 *
 * A deleted Agent keeps its Messages and Tasks so history stays readable, but is hidden from
 * every directory, list, wake, control and profile lookup, and can never mint another Agent API
 * key. Read the raw row (without this filter) only from the deletion module itself and from the
 * message projections that render a deleted sender.
 */
export const ACTIVE_AGENT_WHERE = { deletedAt: null } satisfies Prisma.AgentWhereInput;
