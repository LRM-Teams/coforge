-- CreateTable
CREATE TABLE "weekly_report_cycles" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_report_cycles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "weekly_reports" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "content" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "weekly_reports_kind_check" CHECK ("kind" IN ('member', 'template')),
    CONSTRAINT "weekly_reports_status_check" CHECK ("status" IN ('draft', 'submitted', 'shared'))
);

CREATE TABLE "weekly_report_highlights" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_report_highlights_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "weekly_report_favorites" (
    "userId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_report_favorites_pkey" PRIMARY KEY ("userId","reportId")
);

CREATE TABLE "weekly_report_templates" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'weekly',
    "sendTime" TEXT NOT NULL DEFAULT '15:00',
    "dimensions" JSONB NOT NULL,
    "mainTitles" JSONB NOT NULL,
    "allMembers" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_report_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "weekly_report_templates_frequency_check" CHECK ("frequency" IN ('weekly'))
);

CREATE TABLE "weekly_report_template_recipients" (
    "templateId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "weekly_report_template_recipients_pkey" PRIMARY KEY ("templateId","userId")
);

CREATE TABLE "record_notes" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "record_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "record_comments" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "reportId" UUID,
    "highlightId" UUID,
    "cycleId" UUID,
    "authorType" TEXT NOT NULL,
    "authorUserId" UUID,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "record_comments_subject_type_check" CHECK ("subjectType" IN ('report', 'highlight', 'cycle')),
    CONSTRAINT "record_comments_author_type_check" CHECK ("authorType" IN ('user', 'system', 'assistant'))
);

CREATE UNIQUE INDEX "weekly_report_cycles_workspaceId_year_week_key" ON "weekly_report_cycles"("workspaceId", "year", "week");
CREATE INDEX "weekly_report_cycles_workspaceId_year_week_idx" ON "weekly_report_cycles"("workspaceId", "year", "week");

CREATE UNIQUE INDEX "weekly_reports_cycleId_authorId_kind_key" ON "weekly_reports"("cycleId", "authorId", "kind");
CREATE INDEX "weekly_reports_workspaceId_authorId_idx" ON "weekly_reports"("workspaceId", "authorId");
CREATE INDEX "weekly_reports_cycleId_kind_idx" ON "weekly_reports"("cycleId", "kind");

CREATE UNIQUE INDEX "weekly_report_highlights_cycleId_key" ON "weekly_report_highlights"("cycleId");
CREATE INDEX "weekly_report_highlights_workspaceId_idx" ON "weekly_report_highlights"("workspaceId");

CREATE INDEX "weekly_report_favorites_reportId_idx" ON "weekly_report_favorites"("reportId");

CREATE INDEX "weekly_report_templates_workspaceId_idx" ON "weekly_report_templates"("workspaceId");
CREATE INDEX "weekly_report_template_recipients_userId_idx" ON "weekly_report_template_recipients"("userId");

CREATE INDEX "record_notes_workspaceId_authorId_idx" ON "record_notes"("workspaceId", "authorId");

CREATE INDEX "record_comments_workspaceId_subjectType_createdAt_idx" ON "record_comments"("workspaceId", "subjectType", "createdAt");
CREATE INDEX "record_comments_reportId_idx" ON "record_comments"("reportId");
CREATE INDEX "record_comments_highlightId_idx" ON "record_comments"("highlightId");
CREATE INDEX "record_comments_cycleId_idx" ON "record_comments"("cycleId");

ALTER TABLE "weekly_report_cycles" ADD CONSTRAINT "weekly_report_cycles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_cycles" ADD CONSTRAINT "weekly_report_cycles_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "weekly_report_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_report_highlights" ADD CONSTRAINT "weekly_report_highlights_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_highlights" ADD CONSTRAINT "weekly_report_highlights_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "weekly_report_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_report_favorites" ADD CONSTRAINT "weekly_report_favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_favorites" ADD CONSTRAINT "weekly_report_favorites_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "weekly_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_report_templates" ADD CONSTRAINT "weekly_report_templates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_report_template_recipients" ADD CONSTRAINT "weekly_report_template_recipients_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "weekly_report_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weekly_report_template_recipients" ADD CONSTRAINT "weekly_report_template_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "record_notes" ADD CONSTRAINT "record_notes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "record_notes" ADD CONSTRAINT "record_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "weekly_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_highlightId_fkey" FOREIGN KEY ("highlightId") REFERENCES "weekly_report_highlights"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "weekly_report_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
