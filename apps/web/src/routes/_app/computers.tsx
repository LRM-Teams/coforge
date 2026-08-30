import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AddComputerDialog } from "@/components/add-computer-dialog";
import { ComputerContent } from "@/components/computer-content";
import { listComputers } from "@/features/computers/computers.functions";

export const Route = createFileRoute("/_app/computers")({
  loader: () => listComputers(),
  component: ComputersPage,
});

function ComputersPage() {
  const [addComputerOpen, setAddComputerOpen] = useState(false);
  const computers = Route.useLoaderData();

  return (
    <>
      <ComputerContent computers={computers} onAdd={() => setAddComputerOpen(true)} />
      <AddComputerDialog open={addComputerOpen} onOpenChange={setAddComputerOpen} />
    </>
  );
}
