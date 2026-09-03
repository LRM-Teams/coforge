import { useState } from "react";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { RuntimeProvider } from "@coforge/protocol";

import { ComputerDetail } from "@/features/computers/computer-detail";
import { ComputerNotFound } from "@/features/computers/computer-not-found";
import { setRuntimeVisibility } from "@/features/computers/computers.functions";
import { scanRuntimeUsage } from "@/features/computers/usage-scan";
import type { UsageView } from "@/features/computers/runtime-usage";

export const Route = createFileRoute("/_app/computers/$computerId")({
  // The list the parent already loaded is the whole truth about which
  // Computers this Workspace has, so the miss is decided during loading —
  // where a not-found also reaches the response status — not during render.
  loader: async ({ params, parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise;
    const computer = loaderData?.computers.find((candidate) => candidate.id === params.computerId);
    if (!computer) throw notFound();
    return { computer, timeZone: loaderData?.timeZone ?? null };
  },
  component: ComputerDetailPage,
  notFoundComponent: ComputerNotFound,
});

function ComputerDetailPage() {
  const { computerId } = Route.useParams();
  const { computer, timeZone } = Route.useLoaderData();
  const router = useRouter();
  const setVisibility = useServerFn(setRuntimeVisibility);
  // The route component survives a change of `$computerId`, so a snapshot is
  // held against the Computer it was scanned for, never the mounted component.
  const [usage, setUsage] = useState<Record<string, Record<string, UsageView>>>({});

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
      onSetRuntimePublic={async (runtimeId, isPublic) => {
        await setVisibility({ data: { runtimeId, isPublic } });
        await router.invalidate({ sync: true });
      }}
    />
  );
}
