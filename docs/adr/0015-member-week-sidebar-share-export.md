# ADR 0015: Member-week sidebar, report titles, share and export

Status: accepted
Date: 2026-09-15
Updated: 2026-09-17
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
   node. Each week carries `cycleId`, `overviewReportId` (a leader template in
   that cycle used for highlight generation), `highlightId` (nullable), and
   `highlightGenerating`. **Week nodes navigate to that week's 周报要点**:
   when `highlightId` is set, open `/records/{highlightId}`; when null, open
   `/records/weeks/{year}/{week}` (empty state + generate CTA). Chevron still
   expands/collapses member submissions. Unsubmitted recipients are still
   omitted (WR-37 deferred).
2. **No top-level「周报要点」section**: Highlights are reached only through
   member-week nodes (and direct URLs / generate navigation). Catalog may
   still expose `highlights[]` for landing fallbacks and non-sidebar callers.
3. **Default weekly landing**: Prefer the newest `memberWeeks` entry — its
   highlight when present, otherwise the week empty route. If the viewer has
   no member weeks, fall back to the newest catalog highlight when any exist.
4. **Week preview**: Default show 3 weeks with「N 更多 ...」like favorites
   (WR-04 pattern).
5. **Title**: Member report display title is
   `{displayName} {year} W{week} 工作周报`. New assignment rows store that
   string; list/detail may recompute from author + cycle so older rows match.
6. **Share meta**: On Leader review of a submitted assignment, show
   `submittedAt` as「分享于」and the **template parent author** as「分享者」.
7. **Share action**: Copy the current record URL to the clipboard (toast on
   success). No new Message or public link.
8. **Export action**: Download the report body as a `.md` file (tabs as `#`
   headings). Client-only; no server export job.

## Rejected alternatives

- Showing unsubmitted recipients as「未读」under the week (WR-37): still
  conflicts with ADR 0011 child visibility; needs a separate decision.
- Keep one sidebar row per template parent: rejected; design is week-first.
- Week nodes expand/collapse only with overview only via direct URL (prior
  0015 wording): rejected in favour of week → highlight navigation.
- Nested「周报要点」leaf under each week: rejected; the week node itself is
  the highlight entry (option A).
- Server-side share tokens / OSS export: deferred.

## Consequences

- `memberTemplates` catalog field is replaced by `memberWeeks`.
- Overview documents remain reachable by direct URL / existing send paths;
  they are not listed as week children.
- Title string change updates `memberReportTitle` and assignment create paths.
- WR-01/WR-02 default landing and sidebar section copy follow this ADR.
