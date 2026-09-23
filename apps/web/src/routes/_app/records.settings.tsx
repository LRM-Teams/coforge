import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { WeeklyReportSettings } from "#src/features/records/weekly-report-settings";
import { loadKeyPointPrompts, loadWeeklyTemplates } from "#src/features/records/records.functions";
import { sanitizeRecordsReturnTo } from "#src/features/records/records-return-to";
import type { RecordsTab } from "#src/features/records/records-layout";
import { loadWorkspaceMembers } from "#src/features/workspaces/members.functions";

export type SettingsSection = "templates" | "key_points";
export type KeyPointSlotSearch = "team" | "personal";

export { sanitizeRecordsReturnTo };

export const Route = createFileRoute("/_app/records/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab: RecordsTab;
    create?: boolean;
    section?: SettingsSection;
    slot?: KeyPointSlotSearch;
    returnTo?: string;
  } => ({
    tab: search.tab === "notes" ? "notes" : "weekly",
    create: search.create === true || search.create === "1" ? true : undefined,
    section: search.section === "key_points" ? "key_points" : undefined,
    slot: search.slot === "team" || search.slot === "personal" ? search.slot : undefined,
    returnTo: sanitizeRecordsReturnTo(search.returnTo),
  }),
  loader: async () => {
    const [templates, members, keyPointPrompts] = await Promise.all([
      loadWeeklyTemplates(),
      loadWorkspaceMembers(),
      loadKeyPointPrompts(),
    ]);
    return { templates, members: members.members, keyPointPrompts };
  },
  errorComponent: PageLoadError,
  component: WeeklyReportSettingsPage,
});

function WeeklyReportSettingsPage() {
  const data = Route.useLoaderData();
  const { create, section, slot, returnTo } = Route.useSearch();
  return (
    <WeeklyReportSettings
      templates={data.templates}
      members={data.members}
      keyPointPrompts={data.keyPointPrompts}
      openCreateOnMount={create === true}
      initialSection={section}
      initialSlot={slot}
      returnTo={returnTo}
    />
  );
}
