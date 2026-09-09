import { useMatch, useRouter } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";
import { BackToAgents } from "./conversation-layout";

export function MessagesPending() {
  return (
    <main className="flex h-svh min-w-0 bg-card">
      <nav
        aria-busy="true"
        aria-label={m.messages_agent_list_label()}
        className="hidden w-72 shrink-0 flex-col overflow-hidden border-r bg-card md:flex xl:w-80"
      >
        <div className="flex h-14 shrink-0 items-center border-b px-5">
          <h1 className="text-base font-semibold">{m.messages_title()}</h1>
        </div>
        <div className="overflow-hidden px-3 py-4">
          {[m.channels_title(), m.messages_agents_action()].map((label) => (
            <div key={label} className="mb-6">
              <h2 className="px-3 py-2 text-xs font-semibold text-muted-foreground">{label}</h2>
              <div aria-hidden="true" className="space-y-1 motion-safe:animate-pulse">
                {["w-3/5", "w-2/5", "w-1/2"].map((width) => (
                  <div key={width} className="flex h-11 items-center gap-3 px-2.5">
                    <Skeleton className="size-6 shrink-0 rounded-full" />
                    <Skeleton className={`h-3 ${width}`} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card">
        <ConversationPending />
      </section>
    </main>
  );
}

export function ConversationPending() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-5">
        <BackToAgents />
        <p role="status" className="sr-only">
          {m.conversation_loading()}
        </p>
      </header>
      <div
        aria-busy="true"
        aria-label={m.conversation_history()}
        className="min-h-0 flex-1 overflow-hidden p-4 sm:p-5"
      >
        <div aria-hidden="true" className="space-y-8 motion-safe:animate-pulse">
          {["w-4/5", "w-3/5", "w-2/3", "w-1/2"].map((width) => (
            <div key={width} className="flex gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2.5 pt-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className={`h-3 ${width}`} />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ConversationLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-5">
        <BackToAgents />
        <h1 className="text-base font-semibold">{m.messages_title()}</h1>
      </header>
      <div className="grid flex-1 place-content-center gap-4 p-6 text-center">
        <AlertCircle aria-hidden="true" className="mx-auto size-5 text-destructive" />
        <p role="alert" className="text-sm">
          {m.conversation_history_load_error()}
        </p>
        {isAppError(error) && error.errorId && (
          <p className="text-xs text-muted-foreground">
            {m.error_reference({ errorId: error.errorId })}
          </p>
        )}
        <Button
          variant="outline"
          className="justify-self-center"
          onClick={() => void router.invalidate({ filter: (match) => match.routeId === routeId })}
        >
          {m.controls_retry()}
        </Button>
      </div>
    </div>
  );
}
