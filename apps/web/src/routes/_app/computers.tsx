import { useState } from "react";
import { Outlet, createFileRoute, getRouteApi, useParams } from "@tanstack/react-router";

import { AddComputerDialog } from "@/features/computers/add-computer-dialog";
import { ComputerLayout } from "@/features/computers/computer-layout";
import { listComputers } from "@/features/computers/computers.functions";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getInstallOrigin } from "@/features/install/install.functions";
import { getUserPreferences } from "@/features/settings/settings.functions";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/computers")({
  loader: async () => {
    const [computers, preferences, installOrigin] = await Promise.all([
      listComputers(),
      getUserPreferences(),
      getInstallOrigin(),
    ]);
    return { computers, timeZone: preferences.timeZone, installOrigin };
  },
  errorComponent: PageLoadError,
  component: ComputersPage,
});

function ComputersPage() {
  const { computers, installOrigin } = Route.useLoaderData();
  const { currentWorkspace } = appRoute.useLoaderData();
  const params = useParams({ from: "/_app/computers/$computerId", shouldThrow: false });
  const [addComputerOpen, setAddComputerOpen] = useState(false);

  return (
    <>
      <ComputerLayout
        computers={computers}
        selectedComputerId={params?.computerId}
        onAdd={() => setAddComputerOpen(true)}
      >
        <Outlet />
      </ComputerLayout>
      <AddComputerDialog
        open={addComputerOpen}
        onOpenChange={setAddComputerOpen}
        installOrigin={installOrigin}
        workspaceSlug={currentWorkspace?.slug ?? null}
      />
    </>
  );
}
