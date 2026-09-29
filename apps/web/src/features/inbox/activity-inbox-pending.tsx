import { PageHeader } from "#src/components/layout/page-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";

/** The Activity page while its first page loads (the route's pending fallback). */
export function ActivityInboxPending() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={m.activity_inbox_loading()}
      className="flex h-full min-h-0 flex-col"
    >
      {/* The tabs' place, so the list does not move when the page lands. */}
      <PageHeader heading={m.navigation_activity()} tabs={<Skeleton className="mb-3 h-6 w-64" />} />
      <ol className="flex flex-col gap-2 p-4 sm:px-6">
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className="rounded-xl border border-secondary p-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="mt-2 h-4 w-3/4" />
          </li>
        ))}
      </ol>
    </div>
  );
}
