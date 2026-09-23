import { Plus, SearchLg as Search } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { MobileNavigationButton } from "@/components/layout/sidebar/mobile-header";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";

export function AgentsPending() {
  return (
    <main className="flex h-svh min-w-0">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
        <header className="relative flex shrink-0 flex-wrap items-center gap-x-3 border-b border-secondary px-4 sm:px-6 md:h-12 md:flex-nowrap">
          <div className="flex h-12 min-w-0 flex-1 items-center gap-3 md:flex-none">
            <MobileNavigationButton />
            <h1 className="truncate text-lg font-semibold text-primary">{m.navigation_agents()}</h1>
          </div>
          <div
            aria-hidden="true"
            className="order-last flex basis-full gap-6 self-end md:absolute md:inset-x-0 md:bottom-0 md:mx-auto md:w-max md:basis-auto"
          >
            {[m.member_tab_agents(), m.member_tab_humans()].map((label) => (
              <span
                key={label}
                className="flex items-center gap-1 px-0.5 pb-2.5 text-sm font-semibold text-quaternary"
              >
                {label}
                <Skeleton className="h-4 w-6 rounded-full" />
              </span>
            ))}
          </div>
          <div className="ml-auto flex shrink-0 items-center">
            <Button size="sm" color="primary" iconLeading={Plus} isDisabled>
              {m.header_new_agent()}
            </Button>
          </div>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 pt-5 sm:px-6">
          <Skeleton aria-hidden="true" className="h-9 w-32 rounded-lg" />
          <Skeleton aria-hidden="true" className="h-9 w-44 rounded-lg" />
          <Input
            type="search"
            size="sm"
            icon={Search}
            aria-label={m.filters_search()}
            placeholder={`${m.filters_search()}...`}

            isDisabled
            className="w-full sm:w-80"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
          <p role="status" className="sr-only">
            {m.agents_loading()}
          </p>
          <section
            aria-busy="true"
            aria-label={m.navigation_agents()}
            className="mt-4 grid gap-4 md:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]"
          >
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div
                key={index}
                aria-hidden="true"
                className="flex min-h-48 min-w-0 flex-col rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset"
              >
                <div className="flex flex-1 flex-col gap-2.5 motion-safe:animate-pulse">
                  <div className="flex items-start justify-between">
                    <Skeleton className="size-12 shrink-0 rounded-full" />
                    <Skeleton className="h-9 w-16 rounded-lg" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Skeleton className="h-4 w-2/5" />
                      <Skeleton className="h-5 w-24 rounded-full" />
                    </div>
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3.5 w-2/3" />
                  </div>
                  <div className="mt-auto flex items-center gap-4 pt-1">
                    <Skeleton className="size-6 rounded-full" />
                    <Skeleton className="h-3 w-1/4" />
                    <Skeleton className="h-3 w-1/4" />
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
