import { Plus, SearchLg as Search } from "@untitledui/icons";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/base/buttons/button";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";

export function AgentsPending() {
  return (
    <main className="flex h-svh min-w-0">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
        <PageHeader
          heading={m.navigation_agents()}
          actions={
            <Button size="sm" iconLeading={Plus} isDisabled>
              {m.header_new_agent()}
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <div
              aria-hidden="true"
              className="flex gap-0.5 rounded-lg bg-secondary p-1 ring-1 ring-secondary ring-inset"
            >
              {[m.filters_all(), m.member_person(), m.member_agent()].map((label) => (
                <span
                  key={label}
                  className="flex h-11 items-center gap-2 px-3 text-sm font-semibold text-tertiary md:h-9"
                >
                  {label}
                  <Skeleton className="h-5 w-6 rounded-full" />
                </span>
              ))}
            </div>
            <label className="flex h-11 w-full items-center gap-2 rounded-lg bg-primary px-3 text-sm shadow-xs ring-1 ring-secondary ring-inset sm:ml-auto sm:w-72">
              <Search aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
              <input
                type="search"
                disabled
                aria-label={m.filters_search()}
                placeholder={`${m.filters_search()}...`}
                className="min-w-0 flex-1 bg-transparent placeholder:text-tertiary"
              />
            </label>
          </div>
          <p role="status" className="sr-only">
            {m.agents_loading()}
          </p>
          <section
            aria-busy="true"
            aria-label={m.navigation_agents()}
            className="mt-6 grid gap-5 md:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]"
          >
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div
                key={index}
                aria-hidden="true"
                className="flex min-h-56 min-w-0 flex-col rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset"
              >
                <div className="flex flex-1 flex-col motion-safe:animate-pulse">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-12 shrink-0 rounded-xl" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-3/5" />
                      <Skeleton className="h-3 w-2/5" />
                    </div>
                  </div>
                  <div className="mt-5 space-y-2">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <div className="mt-auto flex items-center gap-3 pt-5">
                    <Skeleton className="h-5 w-12 rounded-md" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              </div>
            ))}
          </section>
        </div>
      </section>
    </main>
  );
}
