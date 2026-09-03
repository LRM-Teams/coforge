import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { RuntimeProvider } from "@coforge/protocol";

import { AddComputerDialog } from "@/components/add-computer-dialog";
import { ComputerContent } from "@/components/computer-content";
import { AppPageError } from "@/features/workspaces/workspace-unavailable";
import type { UsageView } from "@/components/runtime-usage";
import { listComputers, readUsage, scanUsage } from "@/features/computers/computers.functions";
import { waitForUsageScanResult } from "@/features/computers/usage-poll";

export const Route = createFileRoute("/_app/computers")({
  loader: () => listComputers(),
  errorComponent: AppPageError,
  component: ComputersPage,
});

function ComputersPage() {
  const [addComputerOpen, setAddComputerOpen] = useState(false);
  const loadedComputers = Route.useLoaderData();
  const [usage, setUsage] = useState<Record<string, Record<string, UsageView>>>({});
  const scan = async (computerId: string, provider: RuntimeProvider) => {
    try {
      const started = await scanUsage({ data: { computerId, provider } });
      const result = await waitForUsageScanResult(started.scanId, () =>
        readUsage({ data: { computerId, provider } }),
      );
      const status: UsageView["status"] =
        result.status === "available" ||
        result.status === "unavailable" ||
        result.status === "reauth" ||
        result.status === "unsupported"
          ? result.status
          : "error";
      setUsage((current) => ({
        ...current,
        [computerId]: {
          ...current[computerId],
          [provider]: { status, message: result.message, snapshot: result.snapshot },
        },
      }));
    } catch (error) {
      setUsage((current) => ({
        ...current,
        [computerId]: {
          ...current[computerId],
          [provider]: {
            status: "error",
            message: error instanceof Error ? error.message : "Usage scan failed",
          },
        },
      }));
      throw error;
    }
  };

  return (
    <>
      <ComputerContent
        computers={loadedComputers.map((computer) => ({
          ...computer,
          runtimes: computer.runtimes.map((runtime) => ({
            ...runtime,
            provider: runtimeProvider(runtime.provider),
          })),
          usage: usage[computer.id],
        }))}
        onAdd={() => setAddComputerOpen(true)}
        onScanUsage={scan}
      />
      <AddComputerDialog open={addComputerOpen} onOpenChange={setAddComputerOpen} />
    </>
  );
}

function runtimeProvider(value: string): RuntimeProvider {
  if (value === "codex" || value === "claude-code" || value === "pi") return value;
  throw new Error("Computer reported an unknown runtime provider");
}
