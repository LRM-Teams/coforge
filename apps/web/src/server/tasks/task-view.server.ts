import type { TaskMember, TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";
import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  MESSAGE_MENTIONS_SELECT,
  agentReadableBody,
} from "#src/server/conversations/mentions.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

/**
 * How a stored Task reads: the rows a Task read selects, the `TaskView` the task board and an
 * Agent's `task` commands see them as, and the stored status every Task reader parses.
 */

export const TASK_MEMBER_SELECT = {
  id: true,
  userId: true,
  agentId: true,
  leftAt: true,
  user: { select: { username: true, displayName: true, avatarObjectKey: true } },
  agent: { select: { name: true, displayName: true, deletedAt: true } },
} satisfies Prisma.ConversationMemberSelect;

export const taskSelection = {
  messageId: true,
  conversationId: true,
  workspaceId: true,
  number: true,
  title: true,
  description: true,
  createsResource: true,
  resourceReceipt: true,
  resourceReceiptRecordedAt: true,
  status: true,
  revision: true,
  claimedAt: true,
  createdAt: true,
  updatedAt: true,
  ownerMemberId: true,
  owner: { select: TASK_MEMBER_SELECT },
  creator: { select: TASK_MEMBER_SELECT },
  // The backing message's sequence, so realtime signals need no second read, and its mention rows,
  // which a title converted from that message needs to read its mention tokens back.
  message: {
    select: { sequence: true, mentions: MESSAGE_MENTIONS_SELECT },
  },
} satisfies Prisma.TaskSelect;

export type SelectedTask = Prisma.TaskGetPayload<{ select: typeof taskSelection }>;

export function storedTaskStatus(value: string): TaskStatus {
  switch (value) {
    case "todo":
    case "in_progress":
    case "in_review":
    case "done":
    case "closed":
      return value;
    default:
      throw new AppError("INTERNAL_ERROR");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Task's owner or creator; a conversation member is exactly one of a User or an Agent. */
export function taskMember(
  workspaceId: string,
  member: Prisma.ConversationMemberGetPayload<{ select: typeof TASK_MEMBER_SELECT }>,
): TaskMember {
  if (member.agent)
    return {
      memberId: member.id,
      kind: "agent",
      id: member.agentId!,
      name: member.agent.displayName || member.agent.name,
      handle: member.agent.name,
      // A deleted Agent keeps the Tasks it holds so history stays readable; the marker says so
      // rather than letting the card read as if the holder were still live.
      deleted: member.agent.deletedAt !== null,
      ...(member.leftAt !== null && { left: true }),
    };
  const user = member.user!;
  return {
    memberId: member.id,
    kind: "user",
    id: member.userId!,
    name: user.displayName || `@${user.username}`,
    handle: user.username,
    ...(member.leftAt !== null && { left: true }),
    avatarUrl: workspaceUserAvatarUrl(workspaceId, member.userId!, user.avatarObjectKey),
  };
}

export function taskView(task: SelectedTask): TaskView {
  const resourceReceipt = task.resourceReceipt;
  return {
    messageId: task.messageId,
    conversationId: task.conversationId,
    number: task.number,
    // A title converted from a message keeps that message's stored tokens; they read back as text
    // (`@handle`, `task #N`, `#name`) here, the view both the task board and an Agent's `task`
    // commands read.
    title: agentReadableBody(task.title, task.message.mentions),
    description: task.description,
    status: storedTaskStatus(task.status),
    revision: task.revision,
    claimedAt: task.claimedAt?.toISOString() ?? null,
    requiresResourceReceipt: task.createsResource,
    resourceReceiptRecordedAt: task.resourceReceiptRecordedAt?.toISOString() ?? null,
    ...(isRecord(resourceReceipt) && {
      resourceReceipt: {
        object: String(resourceReceipt.object ?? ""),
        purpose: String(resourceReceipt.purpose ?? ""),
        teardownOwner: String(resourceReceipt.teardownOwner ?? ""),
        securityPrivacy: String(resourceReceipt.securityPrivacy ?? ""),
        expiry: String(resourceReceipt.expiry ?? ""),
        runbook: String(resourceReceipt.runbook ?? ""),
        tracking: String(resourceReceipt.tracking ?? ""),
      },
    }),
    owner: task.owner && taskMember(task.workspaceId, task.owner),
    creator: taskMember(task.workspaceId, task.creator),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
