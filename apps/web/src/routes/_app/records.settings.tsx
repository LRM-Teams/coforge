import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { WeeklyReportSettings } from "@/features/records/weekly-report-settings";
import {
  loadKeyPointPrompts,
  loadWeeklyTemplates,
} from "@/features/records/records.functions";
import type { RecordsTab } from "@/features/records/records-layout";
import { loadWorkspaceMembers } from "@/features/workspaces/members.functions";

export const Route = createFileRoute("/_app/records/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab: RecordsTab; create?: boolean } => ({
    tab: search.tab === "notes" ? "notes" : "weekly",
    create: search.create === true || search.create === "1" ? true : undefined,
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
  const { create } = Route.useSearch();
  return (
    <WeeklyReportSettings
      templates={data.templates}
      members={data.members}
      keyPointPrompts={data.keyPointPrompts}
      openCreateOnMount={create === true}
    />
  );
}
