import type { TaskMember, TaskView } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { VISIBLE_CONVERSATION_WHERE } from "#src/server/conversations/active-member.server";
import {
  FINISHED_TASK_STATUSES,
  storedTaskStatus,
  CONVERSATION_KIND_WHERE,
  TASK_MEMBER_SELECT,
  taskMember,
  taskSelection,
  taskView,
  UNFINISHED_TASK_STATUSES,
  type FinishedTaskStatus,
} from "./task-view.server";

export type TaskOverview = {
  tasks: Array<
    TaskView & {
      currentMemberId: string | null;
      source: {
        channelName: string | null;
        agentId: string | null;
        label: string;
      };
      /** The Project the task's channel belongs to; a DM task has none. */
      project: { id: string; name: string; slug: string } | null;
    }
  >;
};

/** Whose finished Tasks a read covers: the Workspace Tasks page's, or one conversation's. */
export type FinishedTaskScope = { workspaceId: string; userId: string; conversationId?: string };
/** How far back the board reads finished Tasks, by their last update. */
export type FinishedTaskWindow = "week" | "month" | "all";
const FINISHED_PAGE_SIZE = 50;
export type FinishedTaskPage = { tasks: TaskOverview["tasks"]; nextCursor: string | null };
/**
 * Finished Tasks counted by status, owner and Project. `currentMemberId` is the owner's membership
 * when the viewer owns them, as on an overview row, so the board tells "me" apart the same way.
 */
export type FinishedTaskSummary = {
  groups: Array<{
    status: FinishedTaskStatus;
    owner: TaskMember | null;
    currentMemberId: string | null;
    project: { id: string; name: string; slug: string } | null;
    count: number;
  }>;
};

function finishedWindowStart(window: FinishedTaskWindow): Date | undefined {
  const days = { week: 7, month: 30, all: null }[window];
  return days === null ? undefined : new Date(Date.now() - days * 86_400_000);
}

/** A page boundary: the last row's update time (stored to the millisecond) and its id. */
function finishedCursor(updatedAt: Date, messageId: string) {
  return `${updatedAt.toISOString()}_${messageId}`;
}

function parseFinishedCursor(cursor: string) {
  const [at, messageId] = cursor.split("_");
  const updatedAt = new Date(at ?? "");
  if (Number.isNaN(updatedAt.getTime()) || !messageId || !/^[0-9a-f-]{36}$/.test(messageId))
    throw new AppError("INVALID_INPUT");
  return { updatedAt, messageId };
}

/**
 * The Tasks page's owner and Project picks: User or Agent ids and Project ids, where `none` stands
 * for no owner or no Project, as the page's `owners` and `projects` search params carry them. An
 * empty pick keeps every Task.
 */
export type FinishedTaskFilter = { owners?: readonly string[]; projects?: readonly string[] };
const NONE = "none";

function finishedFilterWhere({ owners = [], projects = [] }: FinishedTaskFilter) {
  const where: Prisma.TaskWhereInput[] = [];
  if (owners.length > 0) {
    const ids = owners.filter((id) => id !== NONE);
    where.push({
      OR: [
        ...(owners.includes(NONE) ? [{ ownerMemberId: null }] : []),
        ...(ids.length > 0
          ? [{ owner: { OR: [{ userId: { in: ids } }, { agentId: { in: ids } }] } }]
          : []),
      ],
    });
  }
  if (projects.length > 0) {
    const ids = projects.filter((id) => id !== NONE);
    where.push({
      conversation: {
        OR: [
          ...(projects.includes(NONE) ? [{ projectId: null }] : []),
          ...(ids.length > 0 ? [{ projectId: { in: ids } }] : []),
        ],
      },
    });
  }
  return where;
}

/**
 * The conversations whose Tasks the Workspace Tasks page shows: every visible channel. A direct
 * message's Tasks, the viewer's own included, stay on that conversation's Tasks tab.
 */
const OVERVIEW_CONVERSATION_WHERE: Prisma.ConversationWhereInput = {
  // Tasks in a channel hidden from the Workspace leave the overview until it is restored.
  ...VISIBLE_CONVERSATION_WHERE,
  ...CONVERSATION_KIND_WHERE.channel,
};

function overviewSelection(userId: string) {
  return {
    ...taskSelection,
    conversation: {
      select: {
        channelName: true,
        project: { select: { id: true, name: true, slug: true } },
        members: {
          where: { OR: [{ userId }, { agentId: { not: null } }] },
          select: {
            id: true,
            userId: true,
            agent: { select: { id: true, name: true, displayName: true } },
          },
        },
      },
    },
  } satisfies Prisma.TaskSelect;
}

function overviewRow(
  task: Prisma.TaskGetPayload<{ select: ReturnType<typeof overviewSelection> }>,
  userId: string,
): TaskOverview["tasks"][number] {
  const channelName = task.conversation.channelName;
  const agent = task.conversation.members.find((member) => member.agent !== null)?.agent ?? null;
  const currentMemberId =
    task.conversation.members.find((member) => member.userId === userId)?.id ?? null;
  if (channelName === null && agent === null) throw new AppError("INTERNAL_ERROR");
  return {
    ...taskView(task),
    currentMemberId,
    source: channelName
      ? { channelName, agentId: null, label: `#${channelName}` }
      : { channelName: null, agentId: agent!.id, label: agent!.displayName || agent!.name },
    project: task.conversation.project,
  };
}

/**
 * Which one conversation's Tasks a viewer may list, as `TaskBoard`'s `list` decides it: the
 * conversation's id, or `ACCESS_DENIED`. A finished-work read scoped to one conversation asks it.
 */
export type TaskListAccess = {
  listableConversation(
    viewer: { workspaceId: string; userId: string },
    conversationId: string,
  ): Promise<string>;
};

/**
 * The Workspace Tasks page's reads: the unfinished overview, one Task opened from the page, and
 * the finished Tasks counted and paged by window. Browser-only; Task writes and an Agent's `task`
 * commands go through `TaskBoard.execute`.
 */
export class TaskOverviewReads {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: TaskListAccess,
  ) {}

  async overview(workspaceId: string, userId: string): Promise<TaskOverview> {
    await this.requireWorkspaceMember(workspaceId, userId);
    const tasks = await this.db.task.findMany({
      where: {
        workspaceId,
        // Finished Tasks only grow; the board pages them through `finishedPage` instead.
        status: { in: UNFINISHED_TASK_STATUSES },
        conversation: OVERVIEW_CONVERSATION_WHERE,
      },
      // Newest first: a group renders its first cards, and new work is what gets looked at.
      orderBy: [{ createdAt: "desc" }, { messageId: "asc" }],
      select: overviewSelection(userId),
    });
    return { tasks: tasks.map((task) => overviewRow(task, userId)) };
  }

  /**
   * One Task as the Tasks page shows it, in any status, or null when the viewer cannot see it
   * there: the page opens a Task it has not loaded (a finished one past its pages) through this.
   */
  async overviewTask(
    scope: { workspaceId: string; userId: string },
    ref: { conversationId: string; number: number },
  ): Promise<TaskOverview["tasks"][number] | null> {
    const { workspaceId, userId } = scope;
    await this.requireWorkspaceMember(workspaceId, userId);
    const task = await this.db.task.findFirst({
      where: {
        workspaceId,
        conversationId: ref.conversationId,
        number: ref.number,
        conversation: OVERVIEW_CONVERSATION_WHERE,
      },
      select: overviewSelection(userId),
    });
    return task && overviewRow(task, userId);
  }

  /**
   * One page of the viewer's finished Tasks in one status, most recently updated first, limited to
   * the chosen window. The next page starts after `nextCursor`; null means this was the last.
   */
  async finishedPage(
    scope: FinishedTaskScope,
    query: {
      status: FinishedTaskStatus;
      window: FinishedTaskWindow;
      cursor?: string | null;
      limit?: number;
    } & FinishedTaskFilter,
  ): Promise<FinishedTaskPage> {
    const { userId } = scope;
    const readable = await this.finishedTaskWhere(scope);
    const limit = Math.min(query.limit ?? FINISHED_PAGE_SIZE, FINISHED_PAGE_SIZE);
    const after = query.cursor ? parseFinishedCursor(query.cursor) : null;
    const tasks = await this.db.task.findMany({
      where: {
        ...readable,
        status: query.status,
        AND: [
          { updatedAt: { gte: finishedWindowStart(query.window) } },
          ...finishedFilterWhere(query),
          ...(after
            ? [
                // The range keeps the index scan short; the pair breaks ties on the same instant.
                { updatedAt: { lte: after.updatedAt } },
                {
                  OR: [
                    { updatedAt: { lt: after.updatedAt } },
                    { updatedAt: after.updatedAt, messageId: { lt: after.messageId } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ updatedAt: "desc" }, { messageId: "desc" }],
      take: limit + 1,
      select: { ...overviewSelection(userId), updatedAt: true },
    });
    const rows = tasks.slice(0, limit);
    const last = rows.at(-1);
    return {
      tasks: rows.map((task) => overviewRow(task, userId)),
      nextCursor:
        tasks.length > limit && last ? finishedCursor(last.updatedAt, last.messageId) : null,
    };
  }

  /**
   * How many finished Tasks the viewer has in the window, per status, owner and Project. The board
   * reads its column counts and its owner and Project choices from these without loading the Tasks.
   */
  async finishedSummary(
    scope: FinishedTaskScope,
    query: { window: FinishedTaskWindow },
  ): Promise<FinishedTaskSummary> {
    const { workspaceId, userId } = scope;
    const readable = await this.finishedTaskWhere(scope);
    const rows = await this.db.task.groupBy({
      by: ["status", "ownerMemberId", "conversationId"],
      where: {
        ...readable,
        status: { in: [...FINISHED_TASK_STATUSES] },
        updatedAt: { gte: finishedWindowStart(query.window) },
      },
      _count: { _all: true },
    });
    const [owners, conversations] = await Promise.all([
      this.db.conversationMember.findMany({
        where: {
          id: { in: rows.flatMap(({ ownerMemberId }) => (ownerMemberId ? [ownerMemberId] : [])) },
        },
        select: TASK_MEMBER_SELECT,
      }),
      this.db.conversation.findMany({
        where: { id: { in: [...new Set(rows.map(({ conversationId }) => conversationId))] } },
        select: { id: true, project: { select: { id: true, name: true, slug: true } } },
      }),
    ]);
    const ownerById = new Map(owners.map((owner) => [owner.id, taskMember(workspaceId, owner)]));
    const projectOf = new Map(conversations.map(({ id, project }) => [id, project]));
    // One group per status, owner and Project: the same person owns through a membership per
    // conversation, and only whether that owner is the viewer matters to the board.
    const groups = new Map<string, FinishedTaskSummary["groups"][number]>();
    for (const row of rows) {
      const owner = row.ownerMemberId ? (ownerById.get(row.ownerMemberId) ?? null) : null;
      const project = projectOf.get(row.conversationId) ?? null;
      const viewerOwns = owner?.kind === "user" && owner.id === userId;
      const status = storedTaskStatus(row.status) as FinishedTaskStatus;
      const key = [status, owner?.id ?? NONE, project?.id ?? NONE].join(":");
      const known = groups.get(key);
      if (known) known.count += row._count._all;
      else
        groups.set(key, {
          status,
          owner,
          currentMemberId: viewerOwns ? owner.memberId : null,
          project,
          count: row._count._all,
        });
    }
    return { groups: [...groups.values()] };
  }

  /**
   * The Tasks a finished-work read may cover: the Workspace Tasks page's conversations, or one
   * conversation the viewer may list the Tasks of (as `list` allows).
   */
  private async finishedTaskWhere(scope: FinishedTaskScope): Promise<Prisma.TaskWhereInput> {
    const { workspaceId, userId, conversationId } = scope;
    if (!conversationId) {
      await this.requireWorkspaceMember(workspaceId, userId);
      return { workspaceId, conversation: OVERVIEW_CONVERSATION_WHERE };
    }
    return {
      workspaceId,
      conversationId: await this.access.listableConversation(
        { workspaceId, userId },
        conversationId,
      ),
    };
  }

  private async requireWorkspaceMember(workspaceId: string, userId: string) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
  }
}
