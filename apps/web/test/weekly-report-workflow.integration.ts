import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WeeklyReportWorkflow } from "#src/server/records/weekly-report-workflow.server";

// Run explicitly against a disposable PostgreSQL database, never production.
const connectionString = Bun.env.WEEKLY_REPORT_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Set WEEKLY_REPORT_TEST_DATABASE_URL to an isolated test database");

test("disabled schedule configuration updates the format used by an immediate send", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const user = await db.user.create({ data: { username: `edit-${crypto.randomUUID()}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `edit-${crypto.randomUUID()}`,
      name: "Template edits",
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  const actor = { workspaceId: workspace.id, userId: user.id };
  const workflow = new WeeklyReportWorkflow(db, {
    notify: async () => ({ status: "notified" }),
  });
  try {
    const configuration = {
      type: "configure" as const,
      requestId: crypto.randomUUID(),
      name: "Editable format",
      sections: [{ title: "Old", children: [] }],
      allMembers: true,
      recipientUserIds: [],
      scheduleEnabled: true,
      sendWeekday: 5,
      sendTime: "15:00",
    };
    const template = (await workflow.execute(actor, configuration)) as { id: string };
    await workflow.execute(actor, {
      ...configuration,
      templateId: template.id,
      scheduleEnabled: false,
      sections: [{ title: "Technique", children: ["Results"] }],
    });
    await workflow.execute(actor, { type: "send", templateId: template.id });
    const inbox = (await workflow.execute(actor, { type: "inbox" })) as {
      reports: Array<{ id: string; kind: string }>;
    };
    const { RecordCatalog } = await import("#src/server/records/record-catalog.server");
    expect(
      await new RecordCatalog(db).readAssistantReportSection({
        ...actor,
        reportId: inbox.reports.find((report) => report.kind === "member")!.id,
        section: "Technique",
      }),
    ).toMatchObject({ markdown: "## Results" });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}, 30_000);

test("template creation reports initialization failures and retries the complete configuration", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const user = await db.user.create({ data: { username: `retry-${crypto.randomUUID()}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `retry-${crypto.randomUUID()}`,
      name: "Creation retries",
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  const actor = { workspaceId: workspace.id, userId: user.id };
  let rejectFormatWrite = true;
  let synchronizeCreationReads = false;
  let missingTemplateReads = 0;
  const bothReadsCompleted = Promise.withResolvers<void>();
  const failingDb = db.$extends({
    query: {
      weeklyReportTemplate: {
        findFirst: async ({ args, query }) => {
          const template = await query(args);
          if (synchronizeCreationReads && !template) {
            missingTemplateReads += 1;
            if (missingTemplateReads === 2) bothReadsCompleted.resolve();
            await bothReadsCompleted.promise;
          }
          return template;
        },
      },
      weeklyReport: {
        create: ({ args, query }) => {
          if (rejectFormatWrite) throw new Error("format write unavailable");
          return query(args);
        },
      },
    },
  });
  const notifier = { notify: async () => ({ status: "notified" as const }) };
  const workflow = new WeeklyReportWorkflow(failingDb as PrismaClient, notifier);
  const configuration = {
    type: "configure" as const,
    requestId: crypto.randomUUID(),
    name: "Retry format",
    sections: [{ title: "Technique", children: ["Results"] }],
    allMembers: true,
    recipientUserIds: [],
    scheduleEnabled: true,
    sendWeekday: 5,
    sendTime: "15:00",
  };
  try {
    await expect(workflow.execute(actor, configuration)).rejects.toThrow(
      "format write unavailable",
    );
    expect(await workflow.execute(actor, { type: "templates" })).toEqual({
      templates: [],
      nextCursor: null,
    });
    rejectFormatWrite = false;
    synchronizeCreationReads = true;
    const [created, concurrentRetry] = (await Promise.all([
      workflow.execute(actor, configuration),
      workflow.execute(actor, configuration),
    ])) as Array<{ id: string }>;
    synchronizeCreationReads = false;
    expect(missingTemplateReads).toBe(2);
    expect(concurrentRetry).toEqual(created!);
    expect(await workflow.execute(actor, configuration)).toEqual(created);
    expect(await workflow.execute(actor, { type: "templates" })).toMatchObject({
      templates: [{ id: created!.id, sections: configuration.sections }],
      nextCursor: null,
    });
    const { RecordCatalog } = await import("#src/server/records/record-catalog.server");
    const catalog = new RecordCatalog(db, notifier);
    const sent = await catalog.runDueScheduledWeeklyAssignments({
      now: new Date("2030-01-04T07:00:00Z"),
    });
    expect(sent.sent).toBe(1);
    const inbox = (await workflow.execute(actor, { type: "inbox" })) as {
      reports: Array<{ id: string; kind: string }>;
    };
    expect(inbox.reports.filter((report) => report.kind === "template")).toHaveLength(2);
    expect(
      await catalog.readAssistantReportSection({
        ...actor,
        reportId: inbox.reports.find((report) => report.kind === "member")!.id,
        section: "Technique",
      }),
    ).toMatchObject({ markdown: "## Results" });
  } finally {
    bothReadsCompleted.resolve();
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}, 30_000);

test("conversation configures, sends once, collects a member submission and writes the team summary", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const owner = await db.user.create({ data: { username: `weekly-owner-${suffix}` } });
  const member = await db.user.create({ data: { username: `weekly-member-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `weekly-${suffix}`,
      name: "Weekly flow",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const actor = { workspaceId: workspace.id, userId: owner.id };
  const notifications: string[] = [];
  const workflow = new WeeklyReportWorkflow(db, {
    notify: async (input) => {
      notifications.push(input.reportId);
      return { status: "notified" };
    },
  });
  try {
    const configuration = {
      type: "configure" as const,
      requestId: crypto.randomUUID(),
      name: "Foundation Models Weekly",
      sections: [{ title: "Summary", children: ["Work Summary", "Next Steps"] }],
      allMembers: false,
      recipientUserIds: [member.id],
      scheduleEnabled: false,
      sendWeekday: 5,
      sendTime: "15:00",
    };
    const configured = (await workflow.execute(actor, configuration)) as { id: string };
    expect(await workflow.execute(actor, configuration)).toMatchObject({ id: configured.id });
    expect(await workflow.execute(actor, { type: "templates" })).toMatchObject({
      templates: [{ id: configured.id }],
    });
    const { RecordCatalog: Catalog } = await import("#src/server/records/record-catalog.server");
    const cycle = await new Catalog(db).ensureCurrentCycle(actor);
    await db.weeklyReport.create({
      data: {
        workspaceId: actor.workspaceId,
        authorId: actor.userId,
        cycleId: cycle.id,
        settingsId: configured.id,
        kind: "template",
        title: "Live format",
        content: { tabs: { Summary: { markdown: "Please include evidence links." } } },
      },
    });
    const results = (await Promise.all([
      workflow.execute(actor, { type: "send", templateId: configured.id }),
      workflow.execute(actor, { type: "send", templateId: configured.id }),
    ])) as Array<{ parentId: string; assignmentCount: number }>;
    expect(results[0]!.parentId).toBe(results[1]!.parentId);
    expect(results[0]!.assignmentCount).toBe(1);
    const memberActor = { ...actor, userId: member.id };
    const inbox = (await workflow.execute(memberActor, { type: "inbox" })) as {
      reports: Array<{ id: string }>;
    };
    expect(inbox.reports).toHaveLength(1);
    const reportId = inbox.reports[0]!.id;
    expect(notifications).toContain(reportId);
    expect(
      await new Catalog(db).readAssistantReportSection({
        ...memberActor,
        reportId,
        section: "Summary",
      }),
    ).toMatchObject({ markdown: "Please include evidence links." });
    await expect(
      workflow.execute(actor, {
        type: "save",
        reportId,
        tabs: { Summary: { markdown: "unauthorized" } },
      }),
    ).rejects.toThrow();
    await workflow.execute(memberActor, {
      type: "save",
      reportId,
      tabs: { Summary: { markdown: "Finished model evaluation." } },
    });
    await workflow.execute(memberActor, { type: "submit", reportId });
    expect(
      await workflow.execute(actor, { type: "status", reportId: results[0]!.parentId }),
    ).toMatchObject({ reports: [{ id: reportId, status: "submitted" }] });
    await workflow.execute(actor, {
      type: "summary",
      reportId: results[0]!.parentId,
      markdown: `- Model evaluation complete. [@Member](/records/${reportId})`,
    });
    const summary = await db.weeklyReport.findUniqueOrThrow({
      where: { id: results[0]!.parentId },
    });
    expect(summary.content).toMatchObject({
      keyPointExtraction: {
        status: "ready",
        markdown: expect.stringContaining("Model evaluation complete"),
      },
    });
    await workflow.execute(memberActor, {
      type: "save",
      reportId,
      tabs: { Summary: { markdown: "Unsent revision" } },
    });
    const { RecordCatalog } = await import("#src/server/records/record-catalog.server");
    expect(
      await new RecordCatalog(db).readAssistantReportSection({
        ...actor,
        reportId,
        section: "Summary",
      }),
    ).toMatchObject({ markdown: "Finished model evaluation." });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
    await db.$disconnect();
  }
}, 30_000);

test("assignment invitations persist once in each recipient's own private assistant DM", async () => {
  const { weeklyReportNotifier } =
    await import("#src/server/records/weekly-report-notification.server");
  const { SendDirectMessage } = await import("#src/server/conversations/direct-message.server");
  const { PrismaDirectConversationRepository } =
    await import("#src/server/db/repositories/direct-conversation.repositories.server");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const user = await db.user.create({
    data: { username: `wn-${crypto.randomUUID().slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `weekly-notice-${crypto.randomUUID()}`,
      name: "Notice",
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  try {
    const sender = new SendDirectMessage(
      new PrismaDirectConversationRepository(db),
      { execute: (_scope, persist) => persist() },
      { publish: async () => {} },
      { messageAvailable: async () => {}, memberChanged: async () => {} },
    );
    const notifier = weeklyReportNotifier(db, sender);
    const notice = {
      workspaceId: workspace.id,
      userId: user.id,
      reportId: crypto.randomUUID(),
      templateName: "Foundation Models Weekly",
      year: 2026,
      week: 40,
    };
    expect(await notifier.notify(notice)).toEqual({ status: "assistant_unconfigured" });
    await notifier.notify(notice);
    const messages = await db.message.findMany({
      where: { workspaceId: workspace.id },
      include: { sender: true },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender?.userId).toBeNull();
    expect(messages[0]!.body).toContain("Foundation Models Weekly");
    expect(messages[0]!.body).toContain(notice.reportId);
    const assistant = await db.weeklyReportAssistant.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    });
    expect(messages[0]!.sender?.agentId).toBe(assistant.agentId);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}, 30_000);

test("configured weekly schedule retries failed invitations without creating a second collection", async () => {
  const { RecordCatalog } = await import("#src/server/records/record-catalog.server");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const user = await db.user.create({
    data: { username: `ws-${crypto.randomUUID().slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `weekly-schedule-${crypto.randomUUID()}`,
      name: "Schedule",
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  const notices: string[] = [];
  const notifier = {
    notify: async (input: { reportId: string }) => {
      notices.push(input.reportId);
      if (notices.length === 1) throw new Error("temporary notification outage");
      return { status: "notified" as const };
    },
  };
  try {
    const workflow = new WeeklyReportWorkflow(db, notifier);
    const configured = (await workflow.execute(
      { workspaceId: workspace.id, userId: user.id },
      {
        type: "configure",
        requestId: crypto.randomUUID(),
        name: "Foundation Models Weekly",
        sections: [{ title: "Summary", children: [] }],
        allMembers: true,
        recipientUserIds: [],
        scheduleEnabled: true,
        sendWeekday: 5,
        sendTime: "15:00",
      },
    )) as { id: string };
    const catalog = new RecordCatalog(db, notifier);
    expect(
      (await catalog.runDueScheduledWeeklyAssignments({ now: new Date("2030-01-04T06:59:00Z") }))
        .sent,
    ).toBe(0);
    const sent = await catalog.runDueScheduledWeeklyAssignments({
      now: new Date("2030-01-04T07:00:00Z"),
    });
    expect(sent.results[0]).toMatchObject({ notifications: [{ status: "failed" }] });
    expect(notices).toHaveLength(1);
    expect(
      (await catalog.runDueScheduledWeeklyAssignments({ now: new Date("2030-01-04T07:01:00Z") }))
        .sent,
    ).toBe(0);
    expect(notices).toHaveLength(2);
    expect(new Set(notices).size).toBe(1);
    const actor = { workspaceId: workspace.id, userId: user.id };
    const ownReportId = notices[0]!;
    await workflow.execute(actor, {
      type: "save",
      reportId: ownReportId,
      tabs: { Summary: { markdown: "Published work" } },
    });
    await workflow.execute(actor, { type: "submit", reportId: ownReportId });
    await workflow.execute(actor, {
      type: "save",
      reportId: ownReportId,
      tabs: { Summary: { markdown: "Private unsent edit" } },
    });
    expect(
      await workflow.execute(actor, {
        type: "sources",
        reportId: sent.results[0]!.parentId!,
        sourceReportId: ownReportId,
        section: "Summary",
      }),
    ).toMatchObject({ reports: [{ id: ownReportId, markdown: "Published work" }] });
    expect(
      await workflow.execute({ workspaceId: workspace.id, userId: user.id }, { type: "templates" }),
    ).toMatchObject({
      templates: [
        {
          id: configured.id,
          scheduleEnabled: true,
          sendWeekday: 5,
          sendTime: "15:00",
          timeZone: "Asia/Shanghai",
        },
      ],
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}, 30_000);
