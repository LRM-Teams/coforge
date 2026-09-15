# ADR 0015: Member-week sidebar, report titles, share and export

Status: accepted
Date: 2026-09-15
Amends: [ADR 0011](0011-leader-weekly-report-assignment.md) (assignment title;
「成员周报」tree shape)

Design M1/M2: Leader「成员周报」lists **ISO-week folders**, each with submitted
member reports; titles are `{姓名} {year} W{week} 工作周报`; the more menu
supports 收藏 / 分享 / 导出.

## Decision

1. **Sidebar projection**: Catalog exposes `memberWeeks[]` (newest week first).
   Each week aggregates submitted/shared member reports whose
   `sourceTemplateId` points at a **template parent authored by the viewer**
   in that ISO week. Multiple parents in the same week merge into one week
   node. Week nodes are expand/collapse only (no separate overview link in
   the sidebar). Unsubmitted recipients are still omitted (WR-37 deferred).
2. **Week preview**: Default show 3 weeks with「N 更多 ...」like favorites
   (WR-04 pattern).
3. **Title**: Member report display title is
   `{displayName} {year} W{week} 工作周报`. New assignment rows store that
   string; list/detail may recompute from author + cycle so older rows match.
4. **Share meta**: On Leader review of a submitted assignment, show
   `submittedAt` as「分享于」and the **template parent author** as「分享者」.
5. **Share action**: Copy the current record URL to the clipboard (toast on
   success). No new Message or public link.
6. **Export action**: Download the report body as a `.md` file (tabs as `#`
   headings). Client-only; no server export job.

## Rejected alternatives

- Showing unsubmitted recipients as「未读」under the week (WR-37): still
  conflicts with ADR 0011 child visibility; needs a separate decision.
- Keep one sidebar row per template parent: rejected; design is week-first.
- Server-side share tokens / OSS export: deferred.

## Consequences

- `memberTemplates` catalog field is replaced by `memberWeeks`.
- Overview documents remain reachable by direct URL / existing send paths;
  they are not listed as week children.
- Title string change updates `memberReportTitle` and assignment create paths.
