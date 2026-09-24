import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { ActivityInboxView } from "#src/features/inbox/activity-inbox-view";
import { ACTIVITY_INBOX_FILTERS } from "#src/features/inbox/activity-inbox.schemas";

export const Route = createFileRoute("/_app/activity")({
  validateSearch: z.object({
    filter: z.enum(ACTIVITY_INBOX_FILTERS).optional().catch(undefined),
  }),
  component: ActivityPage,
});

function ActivityPage() {
  const { filter } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <ActivityInboxView
      filter={filter ?? "all"}
      onFilterChange={(next) =>
        void navigate({ search: { filter: next === "all" ? undefined : next }, replace: true })
      }
    />
  );
}
