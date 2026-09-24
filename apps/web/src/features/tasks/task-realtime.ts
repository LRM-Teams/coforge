import { TASK_STATUSES, type TaskView } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

/**
 * A Task write's announcement: the new copy of each Task it changed and the ids of those it
 * deleted, so an open Tasks page updates those rows without reading its list again. It rides the
 * conversation signal channels: a channel's Tasks on the Workspace channel (every member sees
 * them on the Tasks page), a direct message's only on its human viewer's own channel.
 */
export type TaskChangedEvent = {
  type: "task.changed.v1";
  workspaceId: string;
  conversationId: string;
  tasks: TaskView[];
  /** Message ids of the Tasks the write deleted. */
  deleted: string[];
};

const member = z.object({
  memberId: z.string(),
  kind: z.enum(["user", "agent"]),
  id: z.string(),
  name: z.string(),
  handle: z.string(),
  deleted: z.boolean().optional(),
  avatarUrl: z.string().nullable().optional(),
});

const taskView = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  number: z.number().int(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: z.enum(TASK_STATUSES),
  revision: z.number().int(),
  owner: member.nullable(),
  creator: member.optional(),
  requiresResourceReceipt: z.boolean().optional(),
  resourceReceiptRecordedAt: z.string().nullable().optional(),
  claimedAt: z.string().nullable().optional(),
});

const taskChangedEvent = z.object({
  type: z.literal("task.changed.v1"),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  tasks: z.array(taskView),
  deleted: z.array(z.string().min(1)),
});

/** The event, or undefined for any other publication on the channel (most are messages). */
export function decodeTaskChangedEvent(value: unknown): TaskChangedEvent | undefined {
  const data =
    value instanceof Uint8Array ? (JSON.parse(new TextDecoder().decode(value)) as unknown) : value;
  // The channels carry every message signal: anything else leaves before the full parse.
  if (!data || typeof data !== "object" || Reflect.get(data, "type") !== "task.changed.v1")
    return undefined;
  const parsed = taskChangedEvent.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}
