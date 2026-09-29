import { PageHeader } from "#src/components/layout/page-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";

export function ProjectsPending({ heading = m.projects_title() }: { heading?: string } = {}) {
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader heading={heading} />
      <div aria-busy="true" aria-label={heading} className="space-y-6 px-4 py-6 sm:px-6">
        <p role="status" className="sr-only">
          {m.projects_loading()}
        </p>
        {[0, 1, 2].map((index) => (
          <div key={index} aria-hidden="true" className="flex items-center gap-3">
            <Skeleton className="size-5" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
