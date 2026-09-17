import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { WeekHighlightEmpty } from "@/features/records/week-highlight-empty";

export const Route = createFileRoute("/_app/records/weeks/$year/$week")({
  ssr: "data-only",
  staleTime: 0,
  errorComponent: PageLoadError,
  params: {
    parse: (raw) => {
      const year = Number(raw.year);
      const week = Number(raw.week);
      if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
        throw notFound();
      }
      return { year: String(year), week: String(week) };
    },
  },
  loader: async ({ params, parentMatchPromise }) => {
    const year = Number(params.year);
    const week = Number(params.week);
    const parent = await parentMatchPromise;
    const catalog = parent.loaderData;
    const memberWeek = catalog?.memberWeeks.find((row) => row.year === year && row.week === week);
    if (!memberWeek) throw notFound();
    if (memberWeek.highlightId) {
      throw redirect({
        to: "/records/$recordId",
        params: { recordId: memberWeek.highlightId },
        search: { tab: "weekly" },
      });
    }
    return {
      year: memberWeek.year,
      week: memberWeek.week,
      title: memberWeek.title,
      overviewReportId: memberWeek.overviewReportId,
      canGenerate: memberWeek.submissions.length > 0,
    };
  },
  component: WeekHighlightPage,
});

function WeekHighlightPage() {
  const data = Route.useLoaderData();
  return <WeekHighlightEmpty {...data} />;
}
