import { useRouter } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";

export function PageLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  if (isAppError(error) && error.code === "WORKSPACE_REQUIRED") {
    return (
      <main className="flex-1 p-6">
        <div role="status" className="mx-auto max-w-lg rounded-xl border bg-card p-6">
          <h1 className="text-xl font-semibold tracking-tight">
            {m.workspace_unavailable_title()}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {m.workspace_unavailable_description()}
          </p>
        </div>
      </main>
    );
  }
  return (
    <main className="flex-1 p-6">
      <div role="alert" className="rounded-xl border border-destructive/40 bg-card p-5">
        <p className="font-medium text-destructive-text">{m.app_load_error()}</p>
        <p className="mt-2 text-sm text-muted-foreground">{m.app_load_error_description()}</p>
        {isAppError(error) && error.errorId && (
          <p className="mt-2 text-xs text-muted-foreground">
            {m.error_reference({ errorId: error.errorId })}
          </p>
        )}
        <Button className="mt-4" variant="outline" onClick={() => void router.invalidate()}>
          {m.controls_retry()}
        </Button>
      </div>
    </main>
  );
}

export function GlobalError({ error }: { error: unknown }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-lg">
        <PageLoadError error={error} />
      </div>
    </div>
  );
}
