# Workspace Records (proposed)

Weekly-report persistence is modeled in `apps/web/prisma/schema.prisma` and
migration `20260910000000_workspace_records`. Status is **proposed** until Frank
approves the schema gate. Tables:

- `weekly_report_cycles` — ISO week bucket per Workspace
- `weekly_reports` — member or template document (`content` JSONB outline)
- `weekly_report_favorites` — per-User favorites of member reports
- `weekly_report_templates` + `weekly_report_template_recipients` — send config
- `record_notes` — notes tab placeholder
- `record_comments` — side-panel comments with `authorType`
  `user` | `system` | `assistant` for future AI
