import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { WeeklyReportSettings } from "@/features/records/weekly-report-settings";
import { loadWeeklyTemplates } from "@/features/records/records.functions";
import { loadWorkspaceMembers } from "@/features/workspaces/members.functions";

export const Route = createFileRoute("/_app/records/settings")({
  loader: async () => {
    const [templates, members] = await Promise.all([
      loadWeeklyTemplates(),
      loadWorkspaceMembers(),
    ]);
    return { templates, members: members.members };
  },
  errorComponent: PageLoadError,
  component: WeeklyReportSettingsPage,
});

function WeeklyReportSettingsPage() {
  const data = Route.useLoaderData();
  return <WeeklyReportSettings templates={data.templates} members={data.members} />;
}
