import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AddComputerDialog } from "@/components/add-computer-dialog";
import { ComputerContent } from "@/components/computer-content";

export const Route = createFileRoute("/_app/computers")({
  component: ComputersPage,
});

function ComputersPage() {
  const [addComputerOpen, setAddComputerOpen] = useState(false);

  return (
    <>
      <ComputerContent onAdd={() => setAddComputerOpen(true)} />
      <AddComputerDialog open={addComputerOpen} onOpenChange={setAddComputerOpen} />
    </>
  );
}
