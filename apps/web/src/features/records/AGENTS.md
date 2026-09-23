# Records (weekly reports)

These rules also cover `src/server/records/`.

- Workspace Records (weekly reports) belong to `features/records/` (list/detail,
  settings, stats, side comments, and Server Functions) and
  `server/records/record-catalog.server.ts` (cycles, reports,
  templates, favorites, notes, and comments). Persistence is Prisma under
  Workspace membership. Report bodies use lightweight outline JSON keyed by
  template-dimension tabs. MVP writes only human `user` comments; `assistant`
  authorType and comment `payload` are reserved for later AI side panels.
  The weekly-report assistant's on-demand reads reuse `RecordCatalog` through
  Agent HTTPS `POST /api/agent/v1/weekly-reports`, authorized as the assistant owner User.
  Multi-Computer collect belongs to
  `server/records/weekly-report-collector.server.ts` (per-Computer Collector
  bindings) and `server/records/weekly-report-collect-run.server.ts` (narrow
  Collect Run ledger). Pack submit and side-panel cards are follow-up seams;
  do not add WSS collect-result RPCs. Schema merge requires Frank approval.
