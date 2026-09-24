import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { ActivityInboxPending, ActivityInboxView } from "#src/features/inbox/activity-inbox-view";
import { activityInboxQuery } from "#src/features/inbox/activity-inbox-queries";
import { ACTIVITY_INBOX_FILTERS } from "#src/features/inbox/activity-inbox.schemas";

export const Route = createFileRoute("/_app/activity")({
  validateSearch: z.object({
    filter: z.enum(ACTIVITY_INBOX_FILTERS).optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({ filter: search.filter ?? "all" }),
  // The list lives in the Query cache (live refreshes and paging); the loader only makes the
  // first page of this view ready. Switching views on the page does not wait for it: the cards
  // on screen stay until the next view has loaded.
  loader: async ({ context, deps, parentMatchPromise, cause }) => {
    const parent = await parentMatchPromise;
    const workspaceId = parent.loaderData?.currentWorkspace?.id;
    if (!workspaceId) return;
    const ready = context.queryClient.ensureInfiniteQueryData(
      activityInboxQuery(workspaceId, deps.filter),
    );
    // A failed load shows inline in the view, which reads the same query.
    if (cause === "stay") void ready.catch(() => undefined);
    else await ready;
  },
  pendingComponent: ActivityInboxPending,
  errorComponent: PageLoadError,
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
