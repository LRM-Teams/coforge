# Weekly-report collect — clean port from local WIP

Status: active guide for `feat/weekly-report-collection-alt`  
Date: 2026-09-17  
Authority: [ADR 0032](../adr/0032-weekly-report-collectors-and-collect-run.md)  
Source WIP (do not merge wholesale): local branch `feat/weekly-report-local-collection` @ `be4a13f`

The WIP is useful as a **behavior sketch**, not as code to cherry-pick. Prefer
small deep modules rewritten against ADR 0032.

## Keep (ideas / shapes)

| Idea | Why |
| --- | --- |
| Per User×Computer **collector binding** → one Agent | Matches D1A |
| Owner-only Computer check via `WorkspaceComputer` + `Computer.ownerId` | Hard ownership boundary |
| `ensure*` race handling like WeeklyReportAssistant | Proven pattern |
| Run ↔ member report + per-Computer slots | Narrow Collect Run ledger (D5A) |
| Idempotent pack accept via stable `requestId` | Needed for HTTPS retries |
| Side-panel plan / setup **UX intent** (E1/E2) | Product; rebuild UI later, cleanly |

## Change (must rewrite)

| WIP | ADR 0032 target |
| --- | --- |
| Fake `docs/adr/0027-weekly-report-local-collection.md` | **Delete / never port** — 0027 is Action Cards |
| `WeeklyReportCollectionRun` naming | `WeeklyReportCollectRun` / `weekly_report_collect_runs` |
| Slot statuses `succeeded/skipped` | `ready` / `empty` / `failed` / `stalled` / `cancelled` / `running` |
| Run statuses `running/completed` | `collecting` → `synthesizing` → `awaiting_confirm` → `done` / `cancelled` |
| Binding `defaultScanPaths` as authority | **No.** Paths authoritative on Computer (D4A); run slot stores **snapshot** only |
| Evidence via WSS `WeeklyReportCollect*` proto | **Agent HTTPS** submit-pack (D6A) |
| Fat `collection-run.server.ts` (~435 lines) + many sibling files | Split: collector inventory, collect-run ledger, later pack-accept, later settle/retry |
| Deterministic Daemon scan in `weekly-report-collect.ts` | Collector **Agent** + skill recipes (MVP may still shell; not WSS result RPC) |

## Drop (do not port)

- `daemon_runtime.proto` Collect request/response and codec/RPC wiring
- Centrifugo `createWeeklyReportCollectResultMethod` and related tests
- WIP UI cards / flow / session-card tangle (rebuild against E1/E2 later)
- `collection-compose` / `coverage` / `inspect` until Collect Run + packs are green
- Cloud-authoritative path update APIs that pretend to replace collect-roots

## Public seams for this CR slice

1. **`WeeklyReportCollectors`** (`weekly-report-collector.server.ts`)  
   `listOwnedComputerSlots`, `ensureCollector`, naming helpers.  
   No path mutation; no run start.

2. **`WeeklyReportCollectRuns`** (`weekly-report-collect-run.server.ts`)  
   `start`, `get`, pure settle helpers (`allSlotsTerminal`, `hasReadyPack`).  
   Start requires owned ready collectors + window; snapshots `scanPaths` onto slots.

Later CRs (not this file’s first green): HTTPS pack submit, one platform retry,
synthesizer wake, side-panel cards.

## Module map note

Add under Records in `apps/web/AGENTS.md` when code lands: Collectors + CollectRuns
own persistence; UI calls Server Functions; Daemon/WSS must not grow collect-result
business RPCs.
