import { Plus, SearchLg as Search } from "@untitledui/icons";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/base/buttons/button";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";

export function AgentsPending() {
  return (
    <main className="flex h-svh min-w-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
        <PageHeader
          heading={m.navigation_agents()}
          actions={
            <Button size="sm" iconLeading={Plus} isDisabled>
              {m.header_new_agent()}
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1">
          <aside
            aria-busy="true"
            className="flex w-full min-w-0 shrink-0 flex-col overflow-hidden border-r border-secondary md:w-80"
          >
            <p role="status" className="sr-only">
              {m.agents_loading()}
            </p>
            <div className="shrink-0 border-b border-secondary p-3">
              <label className="flex h-9 w-full items-center gap-2 rounded-lg bg-secondary px-3 text-sm ring-1 ring-secondary ring-inset">
                <Search aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
                <input
                  type="search"
                  disabled
                  aria-label={m.filters_search()}
                  placeholder={`${m.filters_search()}...`}
                  className="min-w-0 flex-1 bg-transparent placeholder:text-tertiary"
                />
              </label>
            </div>
            <div aria-hidden="true" className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <div
                  key={index}
                  className="flex items-center gap-2.5 py-1.5 motion-safe:animate-pulse"
                >
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-3/5" />
                    <Skeleton className="h-3 w-2/5" />
                  </div>
                </div>
              ))}
            </div>
          </aside>
          <section
            aria-hidden="true"
            className="hidden min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex"
          >
            <div className="motion-safe:animate-pulse space-y-4 p-6">
              <div className="flex items-center gap-4">
                <Skeleton className="size-16 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-4 w-20" />
                </div>
              </div>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
