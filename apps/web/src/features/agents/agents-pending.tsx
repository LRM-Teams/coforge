import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";

export function AgentsPending() {
  return (
    <main className="flex-1 p-4 sm:p-5 md:p-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between sm:gap-6">
        <div>
          <span className="text-sm font-medium">{m.header_agents()}</span>
          <h1 className="text-xl font-semibold tracking-tight">{m.content_title()}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{m.content_description()}</p>
        </div>
        <Button disabled>
          <Plus aria-hidden="true" data-icon="inline-start" />
          {m.header_new_agent()}
        </Button>
      </div>
      <label className="mt-6 flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-xs sm:w-64">
        <Search aria-hidden="true" className="size-4 text-muted-foreground" />
        <input
          type="search"
          disabled
          aria-label={m.filters_search()}
          placeholder={`${m.filters_search()}...`}
          className="min-w-0 flex-1 bg-transparent placeholder:text-muted-foreground"
        />
      </label>
      <p role="status" className="sr-only">
        {m.agents_loading()}
      </p>
      <section
        aria-busy="true"
        aria-label={m.header_agents()}
        className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div
            key={index}
            aria-hidden="true"
            className="flex min-h-48 min-w-0 flex-col rounded-xl border bg-card p-4"
          >
            <div className="flex flex-1 flex-col motion-safe:animate-pulse">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              </div>
              <div className="mt-5 space-y-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <div className="mt-auto border-t pt-3">
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
