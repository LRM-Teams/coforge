import type { TaskHistoryChange, TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import type { Prisma } from "#src/generated/prisma/client";
import { agentReadableBody } from "#src/server/conversations/mentions.server";
import { browserSenderHandle } from "#src/server/conversations/sender-display.server";
import { storedTaskStatus, type SelectedTask } from "./task-view.server";

/** Which history events a Task write records, and how a recorded event reads back. */

type HistoryEvent = Prisma.TaskHistoryEventGetPayload<{ select: undefined }>;
/** The member who made a change; its user/Agent handle names it in the history record. */
type HistoryActor = {
  agentId: string | null;
  user?: { username: string } | null;
  agent?: { name: string } | null;
};

export function historyEventView(event: HistoryEvent): TaskHistoryEvent {
  // Rows are written only through historyRows, which types each payload by its event type.
  return {
    id: event.id,
    seq: event.seq,
    actorType: event.actorType,
    actorName: event.actorName,
    createdAt: event.createdAt.toISOString(),
    eventType: event.eventType,
    payload: event.payload,
  } as TaskHistoryEvent;
}

function assigneeChange(task: SelectedTask): TaskHistoryChange {
  return {
    eventType: "assignee_changed",
    payload: {
      assigneeId: task.owner?.agentId ?? task.owner?.userId ?? null,
      assigneeType: task.owner ? (task.owner.agentId ? "agent" : "user") : null,
    },
  };
}

/** A new Task's history: its creation, then its assignee when it was created assigned. */
export function creationChanges(task: SelectedTask): TaskHistoryChange[] {
  const changes: TaskHistoryChange[] = [
    {
      eventType: "created",
      payload: { taskNumber: task.number, status: storedTaskStatus(task.status) },
    },
  ];
  if (task.owner) changes.push(assigneeChange(task));
  return changes;
}

/** What one write changed on a Task, in the order history lists it. */
export function taskChanges(before: SelectedTask, after: SelectedTask): TaskHistoryChange[] {
  const changes: TaskHistoryChange[] = [];
  if (before.ownerMemberId !== after.ownerMemberId) changes.push(assigneeChange(after));
  if (before.status !== after.status)
    changes.push({
      eventType: "status_changed",
      payload: { from: storedTaskStatus(before.status), to: storedTaskStatus(after.status) },
    });
  const amended: Extract<TaskHistoryChange, { eventType: "amended" }>["payload"]["changes"] = {};
  // Titles are compared and recorded as `taskView` shows them, so a title's stored tokens are never
  // written into the record, and a title that reads the same is no change.
  const titles = {
    from: agentReadableBody(before.title, before.message.mentions),
    to: agentReadableBody(after.title, after.message.mentions),
  };
  if (titles.from !== titles.to) amended.title = titles;
  if (before.description !== after.description)
    amended.description = { from: before.description, to: after.description };
  if (amended.title || amended.description)
    changes.push({ eventType: "amended", payload: { changes: amended, revision: after.revision } });
  return changes;
}

/** History rows for one Task, numbered after `latestSeq`. */
export function historyRows(
  taskMessageId: string,
  actor: HistoryActor,
  changes: TaskHistoryChange[],
  latestSeq: number,
): Prisma.TaskHistoryEventCreateManyInput[] {
  return changes.map((change, index) => ({
    taskMessageId,
    seq: latestSeq + index + 1,
    eventType: change.eventType,
    actorType: actor.agentId ? "agent" : "user",
    actorName: browserSenderHandle(actor) ?? null,
    payload: change.payload,
  }));
}
