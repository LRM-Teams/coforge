import { m } from "@/paraglide/messages";

import { isWorkspaceUnavailable } from "@/server/workspaces/workspace-unavailable";

export function AppPageError({ error }: { error: unknown }) {
  const err = error instanceof Error ? error : new Error(String(error));
  if (isWorkspaceUnavailable(err)) {
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
      <div
        role="alert"
        className="rounded-xl border border-destructive/40 p-5 text-destructive-text"
      >
        <p className="font-medium">{m.app_load_error()}</p>
        <p className="mt-2 text-sm">{err.message}</p>
      </div>
    </main>
  );
}
