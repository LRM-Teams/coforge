import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { WeeklyReportStats } from "@/features/records/weekly-report-stats";
import { loadWeeklyReportStats } from "@/features/records/records.functions";

export const Route = createFileRoute("/_app/records/stats")({
  validateSearch: (search: Record<string, unknown>): { year: number; month: number } => {
    const now = new Date();
    const year =
      typeof search.year === "number" && Number.isFinite(search.year)
        ? search.year
        : typeof search.year === "string" && /^\d{4}$/.test(search.year)
          ? Number(search.year)
          : now.getFullYear();
    const month =
      typeof search.month === "number" && search.month >= 1 && search.month <= 12
        ? search.month
        : typeof search.month === "string" && /^\d{1,2}$/.test(search.month)
          ? Math.min(12, Math.max(1, Number(search.month)))
          : now.getMonth() + 1;
    return { year, month };
  },
  loaderDeps: ({ search }) => ({ year: search.year, month: search.month }),
  loader: ({ deps }) => loadWeeklyReportStats({ data: { year: deps.year, month: deps.month } }),
  errorComponent: PageLoadError,
  component: WeeklyReportStatsPage,
});

function WeeklyReportStatsPage() {
  const stats = Route.useLoaderData();
  const { year, month } = Route.useSearch();
  return <WeeklyReportStats stats={stats} year={year} month={month} />;
}
