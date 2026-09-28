import { z } from "zod";

/**
 * The Tasks page's open popup as URL search state: `task=<conversationId>:<number>` names the
 * Task, and the conversation it lives in, whose popup (the Task and its thread) shows over the
 * overview. A reload or a shared link reopens it; no `task` means no popup.
 */
export type OverviewTaskRef = { conversationId: string; number: number };

const TASK_NUMBER = /^[1-9]\d*$/;
const conversationIdSchema = z.uuid();

export function parseOverviewTaskParam(value: string | undefined): OverviewTaskRef | undefined {
  if (!value) return undefined;
  const separator = value.lastIndexOf(":");
  if (separator < 0) return undefined;
  const conversationId = value.slice(0, separator);
  const number = value.slice(separator + 1);
  if (!TASK_NUMBER.test(number) || !conversationIdSchema.safeParse(conversationId).success)
    return undefined;
  return { conversationId, number: Number(number) };
}

export function overviewTaskParam(task: OverviewTaskRef): string {
  return `${task.conversationId}:${task.number}`;
}

/** Validates the raw `task` search param: a well-formed Task reference, or `undefined` (no
 * popup) for anything else, matching the routes' `.catch()` convention. */
export const overviewTaskParamSchema = z
  .string()
  .refine((value) => parseOverviewTaskParam(value) !== undefined)
  .optional()
  .catch(undefined);
