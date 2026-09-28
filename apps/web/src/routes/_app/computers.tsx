import { useCallback, useState } from "react";
import { Outlet, createFileRoute, getRouteApi, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { latestComputerVersionQuery } from "#src/features/computers/latest-version.query";
import { AddComputerDialog } from "#src/features/computers/add-computer-dialog";
import { ComputerLayout, UpgradingComputerProvider } from "#src/features/computers/computer-layout";
import { ComputersPending } from "#src/features/computers/computers-pending";
import { listComputers } from "#src/features/computers/computers.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { getInstallOrigin } from "#src/features/install/install.functions";
import { getUserPreferences } from "#src/features/settings/settings.functions";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/computers")({
  loader: async () => {
    const [computers, preferences, installOrigin] = await Promise.all([
      listComputers(),
      getUserPreferences(),
      getInstallOrigin(),
    ]);
    return {
      computers,
      timeZone: preferences.timeZone,
      installOrigin,
    };
  },
  pendingComponent: ComputersPending,
  errorComponent: PageLoadError,
  component: ComputersPage,
});

function ComputersPage() {
  const { computers, installOrigin } = Route.useLoaderData();
  const { data: latestComputerVersion } = useQuery(latestComputerVersionQuery());
  const { currentWorkspace } = appRoute.useLoaderData();
  const params = useParams({
    from: "/_app/computers/$computerId",
    shouldThrow: false,
  });
  const [addComputerOpen, setAddComputerOpen] = useState(false);
  // The control that starts an upgrade lives on the detail panel behind the outlet; the list's
  // badge reflects the same operation. Several Computers may upgrade at once (each is serialized
  // on its own machine), so this keeps a set rather than a single slot — one flow finishing must
  // never clear another Computer's indicator.
  const [upgradingComputerIds, setUpgradingComputerIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const setUpgradingComputer = useCallback((computerId: string, upgrading: boolean) => {
    setUpgradingComputerIds((current) => {
      const next = new Set(current);
      if (upgrading) next.add(computerId);
      else next.delete(computerId);
      return next;
    });
  }, []);

  return (
    <>
      <UpgradingComputerProvider value={{ upgradingComputerIds, setUpgradingComputer }}>
        <ComputerLayout
          computers={computers}
          selectedComputerId={params?.computerId}
          onAdd={() => setAddComputerOpen(true)}
          latestComputerVersion={latestComputerVersion}
        >
          <Outlet />
        </ComputerLayout>
      </UpgradingComputerProvider>
      <AddComputerDialog
        open={addComputerOpen}
        onOpenChange={setAddComputerOpen}
        installOrigin={installOrigin}
        workspaceSlug={currentWorkspace?.slug ?? null}
      />
    </>
  );
}
