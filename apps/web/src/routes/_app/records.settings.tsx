import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { WeeklyReportSettings } from "@/features/records/weekly-report-settings";
import { loadWeeklyTemplates } from "@/features/records/records.functions";
import { loadWorkspaceMembers } from "@/features/workspaces/members.functions";

export const Route = createFileRoute("/_app/records/settings")({
  validateSearch: (search: Record<string, unknown>): { create?: boolean } => ({
    create: search.create === true || search.create === "1" ? true : undefined,
  }),
  loader: async () => {
    const [templates, members] = await Promise.all([loadWeeklyTemplates(), loadWorkspaceMembers()]);
    return { templates, members: members.members };
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
      openCreateOnMount={create === true}
    />
  );
}
