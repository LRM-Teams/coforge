import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { RecordDetail } from "#src/features/records/record-detail";
import { EmptyRecord } from "#src/features/records/records-layout";
import { loadRecordSubject } from "#src/features/records/records.functions";
import { latestWeeklyLanding } from "#src/features/records/records-sidebar";
import { isAppError } from "#src/lib/app-error";

export const Route = createFileRoute("/_app/records/")({
  ssr: "data-only",
  staleTime: 0,
  errorComponent: PageLoadError,
  loader: async ({ parentMatchPromise }) => {
    const parent = await parentMatchPromise;
    const catalog = parent.loaderData;
    if (!catalog || parent.search.tab === "notes") return { landing: null, subject: null };
    const landing = latestWeeklyLanding({
      memberWeeks: catalog.memberWeeks,
    });
    if (!landing) return { landing: null, subject: null };
    try {
      return {
        landing,
        subject: await loadRecordSubject({ data: { id: landing.id } }),
      };
    } catch (error) {
      if (isAppError(error) && (error.code === "NOT_FOUND" || error.code === "ACCESS_DENIED")) {
        return { landing: null, subject: null };
      }
      throw error;
    }
  },
  component: RecordsIndexPage,
});

function RecordsIndexPage() {
  const { subject } = Route.useLoaderData();
  if (!subject || subject.type !== "report") return <EmptyRecord />;
  return <RecordDetail subject={subject} />;
}
