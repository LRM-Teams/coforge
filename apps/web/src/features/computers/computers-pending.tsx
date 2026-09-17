import { useMatch, useRouter } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";
import { BackToComputers } from "./computer-layout";

export function ComputersPending() {
  return (
    <main aria-busy="true" className="flex h-svh min-w-0">
      <p role="status" className="sr-only">
        {m.computer_loading()}
      </p>
      <nav
        aria-label={m.computer_connected_list()}
        className="hidden w-80 shrink-0 flex-col overflow-hidden border-r border-secondary bg-primary md:flex"
      >
        <div className="flex h-12 shrink-0 items-center border-b border-secondary px-4 sm:px-6">
          <h1 className="text-lg font-semibold text-primary">{m.computer_page_title()}</h1>
        </div>
        <div className="mt-2 flex h-7 shrink-0 items-center pl-5">
          <span className="text-[11px] font-semibold tracking-wide text-quaternary uppercase">
            {m.computer_page_title()}
          </span>
        </div>
        <div aria-hidden="true" className="space-y-1 px-3 pt-1 motion-safe:animate-pulse">
          {["w-3/5", "w-2/5", "w-1/2"].map((width) => (
            <div key={width} className="flex h-16 items-center gap-3 px-3">
              <Skeleton className="size-9 shrink-0 rounded-[10px]" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className={`h-3 ${width}`} />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      </nav>
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
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
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
        <BackToComputers />
        {announce && (
          <p role="status" className="sr-only">
            {m.computer_loading()}
          </p>
        )}
      </header>
      <div
        aria-hidden="true"
        className="@container min-h-0 flex-1 overflow-y-auto p-4 motion-safe:animate-pulse sm:p-6 lg:p-8"
      >
        <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="size-20 shrink-0 rounded-[20px]" />
            <Skeleton className="h-7 w-40" />
          </div>
          <div className="rounded-xl bg-secondary px-4">
            <div className="divide-y divide-secondary">
              {["w-32", "w-40", "w-24", "w-36"].map((width) => (
                <div key={width} className="flex min-h-11 items-center justify-between gap-4 py-3">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className={`h-4 ${width}`} />
                </div>
              ))}
            </div>
          </div>
          <div>
            <Skeleton className="mb-2 ml-4 h-4 w-32" />
            <div className="rounded-xl bg-secondary px-4">
              <div className="divide-y divide-secondary">
                {["w-36", "w-28"].map((width) => (
                  <div
                    key={width}
                    className="flex min-h-11 items-center justify-between gap-4 py-3"
                  >
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className={`h-8 ${width}`} />
                  </div>
                ))}
              </div>
            </div>
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
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
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
          onPress={() =>
            void router.invalidate({
              filter: (match) => match.routeId === routeId,
            })
          }
        >
          {m.controls_retry()}
        </Button>
      </div>
    </div>
  );
}
