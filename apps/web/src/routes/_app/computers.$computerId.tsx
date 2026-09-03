import { useState } from "react";
import { createFileRoute, notFound, useLoaderData } from "@tanstack/react-router";
import type { RuntimeProvider } from "@coforge/protocol";

import { ComputerDetail } from "@/features/computers/computer-detail";
import { scanRuntimeUsage } from "@/features/computers/usage-scan";
import type { UsageView } from "@/features/computers/runtime-usage";

export const Route = createFileRoute("/_app/computers/$computerId")({
  component: ComputerDetailPage,
});

function ComputerDetailPage() {
  const { computerId } = Route.useParams();
  const { computers, timeZone } = useLoaderData({ from: "/_app/computers" });
  // The route component survives a change of `$computerId`, so a snapshot is
  // held against the Computer it was scanned for, never the mounted component.
  const [usage, setUsage] = useState<Record<string, Record<string, UsageView>>>({});

  const computer = computers.find((candidate) => candidate.id === computerId);
  if (!computer) throw notFound();

  const scan = async (provider: RuntimeProvider) => {
    const view = await scanRuntimeUsage(computerId, provider).catch((): UsageView => ({
      status: "error",
    }));
    setUsage((current) => ({
      ...current,
      [computerId]: { ...current[computerId], [provider]: view },
    }));
  };

  return (
    <ComputerDetail
      computer={{ ...computer, usage: usage[computerId] }}
      timeZone={timeZone}
      onScanUsage={scan}
    />
  );
}
