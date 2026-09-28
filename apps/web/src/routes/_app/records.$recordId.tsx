import { createFileRoute, notFound } from "@tanstack/react-router";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { RecordDetail } from "#src/features/records/record-detail";
import { loadRecordSubject } from "#src/features/records/records.functions";
import { sanitizeRecordsReturnTo } from "#src/features/records/records-return-to";
import { isAppError } from "#src/lib/app-error";

export const Route = createFileRoute("/_app/records/$recordId")({
  // Loader may run on the server; TipTap must not SSR (client-only).
  ssr: "data-only",
  // Always revalidate when entering a report so saves from a previous visit win
  // over the first-load loader snapshot.
  staleTime: 0,
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({
    returnTo: sanitizeRecordsReturnTo(search.returnTo),
  }),
  loader: async ({ params }) => {
    try {
      return await loadRecordSubject({ data: { id: params.recordId } });
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") throw notFound();
      throw error;
    }
  },
  errorComponent: PageLoadError,
  component: RecordDetailPage,
});

function RecordDetailPage() {
  const subject = Route.useLoaderData();
  const { returnTo } = Route.useSearch();
  return <RecordDetail subject={subject} returnTo={returnTo} />;
}
