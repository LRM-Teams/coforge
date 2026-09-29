import { z } from "zod";

const id = z.string().uuid();
const page = { cursor: id.optional(), limit: z.number().int().min(1).max(50).optional() };
const section = z.object({
  title: z.string().trim().min(1).max(100),
  children: z.array(z.string().trim().min(1).max(100)).max(30),
});

/** Owner-scoped conversation operations; no caller-supplied workspace or actor. */
export const weeklyReportWorkflowSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("templates"), query: z.string().trim().max(200).optional(), ...page }),
  z.object({ type: z.literal("inbox"), ...page }),
  z.object({ type: z.literal("members"), query: z.string().trim().max(200).optional(), ...page }),
  z.object({ type: z.literal("status"), reportId: id, ...page }),
  z
    .object({
      type: z.literal("sources"),
      reportId: id,
      sourceReportId: id.optional(),
      section: z.string().trim().min(1).max(100).optional(),
      offset: z.number().int().min(0).max(1_000_000).optional(),
      ...page,
    })
    .refine((action) => Boolean(action.sourceReportId) === Boolean(action.section)),
  z.object({
    type: z.literal("configure"),
    requestId: id,
    templateId: id.optional(),
    name: z.string().trim().min(1).max(100),
    sections: z.array(section).min(1).max(30),
    allMembers: z.boolean(),
    recipientUserIds: z.array(id).max(500),
    scheduleEnabled: z.boolean(),
    sendWeekday: z.number().int().min(1).max(7),
    sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):00$/),
  }),
  z.object({ type: z.literal("send"), templateId: id }),
  z.object({
    type: z.literal("save"),
    reportId: id,
    tabs: z
      .record(z.string().min(1).max(100), z.object({ markdown: z.string().max(100_000) }))
      .refine((tabs) => Object.keys(tabs).length > 0 && Object.keys(tabs).length <= 30),
  }),
  z.object({ type: z.literal("submit"), reportId: id }),
  z.object({
    type: z.literal("summary"),
    reportId: id,
    markdown: z.string().trim().min(1).max(100_000),
  }),
]);
export type WeeklyReportWorkflowAction = z.infer<typeof weeklyReportWorkflowSchema>;
