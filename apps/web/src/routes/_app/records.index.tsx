import { createFileRoute } from "@tanstack/react-router";

import { EmptyRecord } from "@/features/records/records-layout";

export const Route = createFileRoute("/_app/records/")({
  component: RecordsIndexPage,
});

function RecordsIndexPage() {
  return <EmptyRecord />;
}
