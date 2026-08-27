import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AddComputerDialog } from "@/components/add-computer-dialog";
import { AppShell } from "@/components/app-shell";
import { ComputerContent } from "@/components/computer-content";

export const Route = createFileRoute("/computers")({ component: ComputersPage });

function ComputersPage() {
  const [addComputerOpen, setAddComputerOpen] = useState(false);

  return (
    <AppShell page="computers">
      <ComputerContent onAdd={() => setAddComputerOpen(true)} />
      <AddComputerDialog open={addComputerOpen} onOpenChange={setAddComputerOpen} />
    </AppShell>
  );
}
