import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { WeeklyReportDashboard } from "#src/features/records/weekly-report-dashboard";
import { loadWeeklyReportDashboard } from "#src/features/records/records.functions";

export const Route = createFileRoute("/w/$workspaceSlug/records/dashboard")({
  validateSearch: (search: Record<string, unknown>): { tab: "weekly" | "notes" } => ({
    tab: search.tab === "notes" ? "notes" : "weekly",
  }),
  loader: () => loadWeeklyReportDashboard({ data: { limit: 6 } }),
  errorComponent: PageLoadError,
  component: WeeklyReportDashboardPage,
});

function WeeklyReportDashboardPage() {
  return <WeeklyReportDashboard dashboard={Route.useLoaderData()} />;
}
