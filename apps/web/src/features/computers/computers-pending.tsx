import { useMatch, useRouter } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";
import { BackToComputers } from "./computer-layout";

export function ComputersPending() {
  return (
    <main aria-busy="true" className="flex h-svh min-w-0 md:gap-2 md:p-2">
      <p role="status" className="sr-only">
        {m.computer_loading()}
      </p>
      <nav
        aria-label={m.computer_connected_list()}
        className="hidden w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-secondary bg-primary md:flex"
      >
        <div className="flex h-14 shrink-0 items-center border-b border-secondary px-5">
          <h1 className="text-base font-medium">{m.computer_page_title()}</h1>
        </div>
        <div aria-hidden="true" className="space-y-1 p-3 motion-safe:animate-pulse">
          {["w-3/5", "w-2/5", "w-1/2"].map((width) => (
            <div key={width} className="flex h-18 items-center gap-3 px-3">
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className={`h-3 ${width}`} />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      </nav>
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary md:rounded-xl md:border md:border-secondary">
        <ComputerDetailSkeleton announce={false} />
      </section>
    </main>
  );
}

export function ComputerDetailPending() {
  return <ComputerDetailSkeleton announce />;
}

function ComputerDetailSkeleton({ announce }: { announce: boolean }) {
  return (
    <div aria-busy={announce ? "true" : undefined} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-secondary px-3 sm:px-5">
        <BackToComputers />
        {announce && (
          <p role="status" className="sr-only">
            {m.computer_loading()}
          </p>
        )}
        <Skeleton className="size-8 shrink-0 rounded-lg" />
        <Skeleton className="h-4 w-36" />
      </header>
      <div
        aria-hidden="true"
        className="@container space-y-8 overflow-y-auto p-4 motion-safe:animate-pulse sm:p-6 lg:p-8"
      >
        <div className="space-y-3">
          <Skeleton className="h-4 w-20" />
          <div className="divide-y divide-secondary border-y border-secondary">
            {["w-32", "w-40", "w-28", "w-20", "w-36", "w-24"].map((width) => (
              <div key={width} className="grid gap-2 py-4 @lg:grid-cols-[minmax(8rem,1fr)_2fr]">
                <Skeleton className="h-3 w-24" />
                <Skeleton className={`h-4 ${width}`} />
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <div className="rounded-xl border border-secondary p-4">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-2 h-3 w-24" />
            <Skeleton className="mt-5 h-8 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ComputerDetailLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  void error;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-secondary px-3 sm:px-5">
        <BackToComputers />
        <h1 className="text-base font-medium">{m.computer_page_title()}</h1>
      </header>
      <div className="grid flex-1 place-content-center gap-4 p-6 text-center">
        <AlertCircle aria-hidden="true" className="mx-auto size-5 text-error-primary" />
        <p role="alert" className="text-sm text-error-primary">
          {m.computer_detail_load_error()}
        </p>
        <Button
          color="secondary"
          className="justify-self-center"
          onPress={() => void router.invalidate({ filter: (match) => match.routeId === routeId })}
        >
          {m.controls_retry()}
        </Button>
      </div>
    </div>
  );
}
