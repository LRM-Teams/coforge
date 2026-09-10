import { createFileRoute, notFound } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { RecordDetail } from "@/features/records/record-detail";
import { loadRecordSubject } from "@/features/records/records.functions";
import { isAppError } from "@/lib/app-error";

export const Route = createFileRoute("/_app/records/$recordId")({
  // Loader may run on the server; TipTap must not SSR (Multica Notes is client-only).
  ssr: "data-only",
  // Always revalidate when entering a report so saves from a previous visit win
  // over the first-load loader snapshot.
  staleTime: 0,
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
  return <RecordDetail subject={subject} />;
}
