import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";

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
    const recordId = memberWeek.submissions[0]?.id ?? memberWeek.overviewReportId;
    if (!recordId) throw notFound();
    throw redirect({
      to: "/records/$recordId",
      params: { recordId },
      search: { tab: "weekly" },
    });
  },
});
