import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "#src/components/base/buttons/button";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";

/**
 * Shared unlinked/denied/unavailable repository message, used by both the project
 * detail page's repository sections and the in-app repository browser.
 */
export function RepositoryStatusMessage({
  status,
  onRetry,
}: {
  status: "unlinked" | "denied" | "unavailable";
  /** Pages that read through React Query refetch here; the default reruns the route loaders. */
  onRetry?: () => Promise<unknown>;
}) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const [retrying, setRetrying] = useState(false);
  const text =
    status === "unlinked"
      ? m.project_no_repository()
      : status === "denied"
        ? m.project_repository_denied()
        : m.project_repository_unavailable();
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
      <p className="text-sm text-tertiary">{text}</p>
      {status !== "unlinked" && (
        <>
          <Link
            to="/w/$workspaceSlug/settings"
            params={{ workspaceSlug }}
            search={{ section: "integrations" }}
            className="text-sm font-medium text-brand-secondary hover:underline"
          >
            {m.project_github_settings()}
          </Link>
          <Button
            size="sm"
            color="secondary"
            isLoading={retrying}
            onPress={async () => {
              setRetrying(true);
              try {
                await (onRetry ? onRetry() : router.invalidate({ sync: true }));
              } finally {
                setRetrying(false);
              }
            }}
          >
            {m.project_retry()}
          </Button>
        </>
      )}
    </div>
  );
}
