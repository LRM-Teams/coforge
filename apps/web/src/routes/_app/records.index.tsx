import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { RecordDetail } from "@/features/records/record-detail";
import { EmptyRecord } from "@/features/records/records-layout";
import { loadRecordSubject } from "@/features/records/records.functions";
import { latestWeeklyHighlight } from "@/features/records/records-sidebar";
import { isAppError } from "@/lib/app-error";

export const Route = createFileRoute("/_app/records/")({
  ssr: "data-only",
  staleTime: 0,
  errorComponent: PageLoadError,
  loader: async ({ parentMatchPromise }) => {
    const parent = await parentMatchPromise;
    const catalog = parent.loaderData;
    if (!catalog || parent.search.tab === "notes") return { subject: null };
    const latest = latestWeeklyHighlight(catalog.highlights);
    if (!latest) return { subject: null };
    try {
      return { subject: await loadRecordSubject({ data: { id: latest.id } }) };
    } catch (error) {
      if (isAppError(error) && (error.code === "NOT_FOUND" || error.code === "ACCESS_DENIED")) {
        return { subject: null };
      }
      throw error;
    }
  },
  component: RecordsIndexPage,
});

function RecordsIndexPage() {
  const { subject } = Route.useLoaderData();
  if (!subject || subject.type !== "highlight") return <EmptyRecord />;
  return <RecordDetail subject={subject} />;
}
