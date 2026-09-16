import { useState } from "react";
import { Outlet, createFileRoute, getRouteApi, useParams } from "@tanstack/react-router";
import { AddComputerDialog } from "@/features/computers/add-computer-dialog";
import { ComputerLayout, UpgradingComputerProvider } from "@/features/computers/computer-layout";
import { ComputersPending } from "@/features/computers/computers-pending";
import { getLatestComputerVersion, listComputers } from "@/features/computers/computers.functions";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getInstallOrigin } from "@/features/install/install.functions";
import { getUserPreferences } from "@/features/settings/settings.functions";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/computers")({
  loader: async () => {
    const [computers, preferences, installOrigin, latestComputerVersion] = await Promise.all([
      listComputers(),
      getUserPreferences(),
      getInstallOrigin(),
      getLatestComputerVersion(),
    ]);
    return {
      computers,
      timeZone: preferences.timeZone,
      installOrigin,
      latestComputerVersion,
    };
  },
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: ComputersPending,
  errorComponent: PageLoadError,
  component: ComputersPage,
});

function ComputersPage() {
  const { computers, installOrigin, latestComputerVersion } = Route.useLoaderData();
  const { currentWorkspace } = appRoute.useLoaderData();
  const params = useParams({
    from: "/_app/computers/$computerId",
    shouldThrow: false,
  });
  const [addComputerOpen, setAddComputerOpen] = useState(false);
  // The control that starts an upgrade lives on the detail panel behind the outlet; the list's
  // badge reflects the same operation, so the page owns which Computer is upgrading.
  const [upgradingComputerId, setUpgradingComputerId] = useState<string>();

  return (
    <>
      <UpgradingComputerProvider value={{ upgradingComputerId, setUpgradingComputerId }}>
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
