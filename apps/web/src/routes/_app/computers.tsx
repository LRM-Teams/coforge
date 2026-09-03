import { useState } from "react";
import { Outlet, createFileRoute, useParams } from "@tanstack/react-router";

import { AppPageError } from "@/features/workspaces/workspace-unavailable";
import { AddComputerDialog } from "@/features/computers/add-computer-dialog";
import { ComputerLayout } from "@/features/computers/computer-layout";
import { listComputers } from "@/features/computers/computers.functions";
import { getUserPreferences } from "@/features/settings/settings.functions";

export const Route = createFileRoute("/_app/computers")({
  loader: async () => {
    const [computers, preferences] = await Promise.all([listComputers(), getUserPreferences()]);
    return { computers, timeZone: preferences.timeZone };
  },
  errorComponent: AppPageError,
  component: ComputersPage,
});

function ComputersPage() {
  const { computers } = Route.useLoaderData();
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
      <AddComputerDialog open={addComputerOpen} onOpenChange={setAddComputerOpen} />
    </>
  );
}
