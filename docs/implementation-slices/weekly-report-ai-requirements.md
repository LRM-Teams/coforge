# Weekly Report AI Assistant Requirements

Status: draft requirements
Date: 2026-09-16
Branch: `feat/weekly-report-ai`

This document records the agreed requirements for adding AI capabilities to Workspace Records weekly reports. It is a requirements and slicing document; implementation must still follow the repository architecture, authorization, testing, and review rules.

Current implementation progress: slices 1–14 authorization/behavior coverage plus
Agent HTTPS/CLI weekly-report reads are in place. Confirmation-backed
body/highlight writes and user-controlled send prompts are implemented.
Manual rendered verification of desktop/mobile, themes, and assistant UI states
remains.

## 1. Product Decisions

- Each User gets one automatically created weekly-report assistant per Workspace.
- The weekly-report assistant has a fixed product-owned name.
- Users cannot choose an existing Agent as the weekly-report assistant.
- Different Users cannot share the same weekly-report assistant.
- Leaders and ordinary members may use the same configuration pattern, but each uses their own assistant.
- The weekly-report assistant is not managed from the Members page.
- The assistant must support Pi, Codex, Claude Code, and Kiro runtimes. Existing CoForge runtime support should remain compatible where applicable.
- Each weekly-report-related page owns an independent right-panel conversation and context.
- Right panels must not create additional browser WebSocket connections.
- The assistant may read all weekly-report data visible to the current User, but data must be fetched on demand rather than all being injected into the prompt.
- First release may modify report body or generate/update highlights only after User confirmation.
- Sending weekly reports must remain a User decision through an explicit button or confirmation flow.
- Configuration reminders appear when the User first opens an AI-capable weekly-report page. If not configured, the first AI action also reminds the User inside the side panel and provides a link/button that opens the configuration dialog.

## 2. Assistant Identity And Configuration

- The system automatically provisions the current User's weekly-report assistant for the current Workspace.
- The assistant is backed by the existing Agent, Computer, Runtime, and Daemon lifecycle model.
- The assistant requires a configured Computer and Runtime before AI actions can run.
- The assistant configuration flow must reuse existing Computer and Runtime capabilities instead of creating a parallel runtime-management system.
- The assistant should not appear as a user-managed Agent in Members.
- Configuration state must distinguish at least:
  - assistant missing or provisioning required;
  - Computer not connected;
  - Runtime not selected;
  - Runtime credential missing;
  - Agent starting;
  - Agent ready;
  - Agent offline;
  - current User cannot configure.

## 3. Runtime Requirements

The configuration flow must support:

- selecting or connecting a Computer;
- selecting a Runtime provider;
- selecting model, model provider, reasoning, and any existing runtime fields;
- configuring required credentials;
- saving configuration;
- starting or waking the assistant;
- refreshing status after configuration.

Supported runtime providers:

- Pi;
- Codex;
- Claude Code;
- Kiro;
- CoForge where already supported by the existing Agent runtime model.

## 4. Configuration Reminder UX

- On first entry into an AI-capable weekly-report page, show a non-blocking configuration reminder in the right panel.
- If the User dismisses or ignores that reminder, do not repeatedly interrupt the same page view.
- If the User later invokes an AI action while the assistant is still unconfigured, show the configuration prompt in the panel again.
- The prompt must include a clear action to open the weekly-report assistant configuration dialog.
- The prompt must not block reading or editing the main weekly-report content.
- Users without permission to configure must see a clear explanation and no misleading configuration CTA.
- Once configuration completes, the panel refreshes into the usable assistant state.

## 5. Independent Right Panel Sessions

Each weekly-report-related page owns independent side-panel state:

- message history;
- draft input;
- loading state;
- error state;
- current page context;
- assistant request state;
- pending confirmation state;
- generated suggestion preview state.

The following pages/surfaces need page-scoped assistant context:

- weekly template editor;
- weekly template preview/send page;
- My weekly report detail;
- member weekly report detail;
- member report overview;
- weekly highlights detail;
- weekly report settings;
- weekly report stats, when AI analysis is added there;
- favorite report surfaces related to weekly reports.

A page-scoped context should be represented by stable identifiers such as:

- `report:<reportId>`;
- `highlight:<highlightId>`;
- `template:<templateId>`;
- `cycle:<cycleId>`;
- `settings:<workspaceId>`.

The app must continue using the existing browser realtime connection model. Do not create one WebSocket per right panel.

## 6. Context Loading Model

The assistant must use progressive context loading.

Initial page context may include:

- page/surface type;
- subject ID;
- Workspace ID;
- current User identity and role facts needed for display;
- cycle year/week when relevant;
- visible outline or section names;
- a compact list of available data groups;
- context version or last-updated marker.

The assistant must not receive all visible weekly-report data by default.

When additional data is needed, it should request scoped reads through authorized server tools. Each read must:

- re-check the current User's authorization server-side;
- be scoped to Workspace, User, assistant, and subject;
- support pagination or section-level reads where content can be large;
- return bounded output;
- return source metadata for citations and UI traceability;
- avoid leaking existence or content of unauthorized reports.

## 7. Readable Data Scope

Within current User authorization, the assistant may read:

- current weekly-report template;
- template outline and sections;
- template status;
- send settings summary;
- current cycle information;
- My weekly report content and submission state;
- visible member reports;
- visible member submission states;
- visible historical member reports;
- current User's favorite reports;
- weekly highlights;
- highlight source reports;
- side-chat content if product and privacy review allow it;
- weekly-report stats when connected to assistant analysis;
- visible weekly-report settings.

## 8. First-Release Assistant Capabilities

The assistant may:

- answer questions about current weekly-report content;
- summarize the current report;
- summarize visible member reports;
- analyze submission status;
- identify missing submissions or weak/empty sections;
- compare member reports or weekly cycles;
- review a report against the template structure;
- generate draft body text;
- generate weekly highlights;
- explain differences between template, submitted reports, highlights, and favorites;
- propose edits;
- produce a preview or diff for User confirmation.

The assistant must not automatically:

- send weekly reports;
- change recipients;
- change schedule settings;
- delete reports;
- favorite or unfavorite reports unless separately approved later;
- post to public channels;
- perform business writes without User confirmation.

## 9. User-Confirmed Writes

All write operations require explicit User confirmation.

- Report body edits must be shown as a preview or diff before save.
- Highlight generation/update must show candidate output before save.
- Sending must be exposed as a button/confirmation that the User chooses.
- Existing send confirmation behavior should be reused where possible.
- On write success, refresh both main content and side-panel context.
- On write failure, preserve the AI suggestion and User draft and show a recoverable error.

## 10. Server-Side Capabilities Needed

Add or extend server-side seams for:

- reading current User weekly-report assistant status;
- provisioning the fixed User-scoped weekly-report assistant;
- reading assistant Computer/Runtime configuration state;
- saving assistant Computer/Runtime configuration;
- starting/waking the assistant;
- creating page-scoped assistant conversations;
- posting page-scoped assistant requests;
- reading page-scoped assistant messages;
- reading compact page context manifests;
- listing visible weekly-report resources;
- reading a report section;
- reading template summary/body;
- reading member submission status;
- reading favorite report summaries;
- reading highlights and sources;
- creating generated write suggestions;
- applying User-confirmed body edits;
- applying User-confirmed highlight updates;
- surfacing a User-controlled send action.

These capabilities must be owned by clear Records/Agents server seams. UI components must not directly encode persistence or authorization rules.

## 11. Agent Skills And Tools

Add weekly-report domain skills for the assistant:

- `weekly-report-navigation`: explains weekly-report objects, page surfaces, and navigation/context rules.
- `weekly-report-analysis`: guides summarization, comparison, status analysis, and source-backed conclusions.
- `weekly-report-writing`: guides draft generation and source-preserving report writing.
- `weekly-report-review`: guides template conformity checks, missing content checks, and quality review.
- `weekly-report-privacy`: reinforces visibility, source, and confidentiality rules.

Skills describe behavior. Real data access and writes must go through authorized tools/server capabilities.

Likely tools/capabilities:

- `weekly_report_context`;
- `weekly_report_list`;
- `weekly_report_read`;
- `weekly_report_template_read`;
- `weekly_report_highlights_read`;
- `weekly_report_compare`;
- `weekly_report_draft_update`;
- `weekly_report_highlight_generate`.

## 12. Authorization And Privacy

- The assistant only reads weekly-report data visible to the current User.
- All reads and writes must be authorized server-side per request.
- The assistant must not gain Workspace-wide report access solely because it is an Agent.
- Ordinary members must not read other members' non-visible reports through the assistant.
- Leader visibility follows existing weekly-report rules.
- Favorite reports are scoped to the current User.
- Prompt/context must not include API keys, environment variables, Computer credentials, or Runtime credentials.
- Logs should not contain full report bodies unless a separate logging/privacy decision explicitly allows it.
- Responses should cite data scope and sources where useful.

## 13. UI States

The side panel must handle:

- unconfigured assistant;
- configuration prompt;
- configuring;
- Computer missing/offline;
- Runtime missing/unavailable;
- credentials missing;
- assistant starting;
- assistant ready;
- assistant busy;
- current page request running;
- generated suggestion awaiting confirmation;
- write in progress;
- write succeeded;
- write failed;
- assistant offline;
- no permission to configure;
- no AI capability available for this page.

Errors that block action should be visible in context rather than only in transient toasts.

## 14. Testing And Verification

Behavioral tests should cover:

- one assistant per User per Workspace;
- automatic assistant provisioning;
- different Users cannot share one assistant;
- assistant not managed from Members;
- configuration state detection;
- visible weekly-report context reads;
- denial of invisible report reads;
- page-scoped conversation isolation;
- User confirmation required before writes;
- no automatic send by Agent;
- bounded/paginated or section-scoped content reads.

UI changes follow `docs/agents/testing.md`:

- do not add UI unit tests;
- manually verify desktop and mobile;
- manually verify light and dark themes;
- verify unconfigured, configured, offline, busy, error, and confirmation states;
- verify keyboard, touch, dialog close, Escape, scroll, and overflow behavior;
- verify page switching does not leak prior page context into the next side panel.

## 15. Suggested Implementation Slices

1. Record the product decisions and requirements. ✅
2. Add the per-User fixed weekly-report assistant server seam. ✅
3. Add side-panel assistant configuration status and prompt. ✅
4. Reuse existing Computer/Runtime configuration UI for the weekly-report assistant. ✅
5. Add page-scoped side-panel assistant session state. ✅
6. Add read-only page context manifest. ✅
7. Add authorized on-demand report/template/highlight read tools. ✅
8. Add weekly-report domain skills. ✅
9. Connect assistant requests/responses to the page-scoped side panel. ✅
10. Add generated report-body suggestions. ✅
11. Add User-confirmed report-body writes. ✅
12. Add User-confirmed highlight generation/update. ✅
13. Add User-controlled send prompt/button. ✅
14. Complete authorization tests and manual UI verification.
    - Authorization/behavior tests: ✅ (`weekly-report-assistant-authorization.test.ts`
      plus earlier assistant/catalog/protocol coverage for provisioning, visible
      reads, page-scoped selection, confirmation writes, and read-only Agent protocol).
    - Manual UI verification: pending (see checklist below).

Agent HTTPS + `coforge weekly-report` CLI reads (owner-User principal) landed after
slice 9. Confirmation-backed writes use a `[weekly-report-suggestion]` message
envelope (no new wire protocol). Authorization tests for invisible-read denial,
author-only confirmed writes, no Agent write ops / no auto-send, and Members
exclusion of the weekly-report assistant are in place.

### Manual UI verification checklist (do not add UI unit tests)

- [ ] desktop + mobile viewport: Records side panel suggestion preview / Confirm / Ignore
- [ ] light + dark themes on the same surfaces
- [ ] unconfigured, configured, offline, busy, error, and confirmation states
- [ ] keyboard / touch / Escape / scroll / overflow on the side panel
- [ ] switching report/highlight pages does not leak prior side-panel context

## 16. Open Design Questions For Implementation

- Whether the weekly-report assistant should be hidden from all Members views or visible only in internal Agent tables.
- Whether side-chat comments and assistant conversations should share storage or split into separate tables/contracts.
- Whether write suggestions should be stored as assistant message payloads, separate drafts, or transient UI state.
- Whether non-CoForge providers receive weekly-report writes through provider-native tool APIs or the existing `coforge` CLI bridge. Reads currently use the CLI bridge.
- Whether assistant-generated output should record source citations in structured payloads.
