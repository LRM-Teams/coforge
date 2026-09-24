import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { ComputerDetail } from "#src/features/computers/computer-detail";
import { ComputerNotFound } from "#src/features/computers/computer-not-found";
import {
  ComputerDetailLoadError,
  ComputerDetailPending,
} from "#src/features/computers/computers-pending";
import {
  readComputerRestartStatus,
  readComputerUpgradeStatus,
  restartComputer,
  setRuntimeVisibility,
  updateComputerDisplayName,
  upgradeComputer,
} from "#src/features/computers/computers.functions";
import { latestComputerVersionQuery } from "#src/features/computers/latest-version.query";

export const Route = createFileRoute("/_app/computers/$computerId")({
  // The list the parent already loaded is the whole truth about which
  // Computers this Workspace has, so the miss is decided during loading —
  // where a not-found also reaches the response status — not during render.
  loader: async ({ params, parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise;
    const computer = loaderData?.computers.find((candidate) => candidate.id === params.computerId);
    if (!computer) throw notFound();
    return {
      computer,
      timeZone: loaderData?.timeZone ?? null,
    };
  },
  pendingComponent: ComputerDetailPending,
  errorComponent: ComputerDetailLoadError,
  component: ComputerDetailPage,
  notFoundComponent: ComputerNotFound,
});

function ComputerDetailPage() {
  const { computerId } = Route.useParams();
  const { computer, timeZone } = Route.useLoaderData();
  // The release-version check is a third-party request, so it is asked for after the render rather
  // than carried in the loader (see `latest-version.query.ts`).
  const { data: latestComputerVersion } = useQuery(latestComputerVersionQuery());
  const router = useRouter();
  const setVisibility = useServerFn(setRuntimeVisibility);
  const updateDisplayName = useServerFn(updateComputerDisplayName);
  const requestRestart = useServerFn(restartComputer);
  const readRestart = useServerFn(readComputerRestartStatus);
  const requestUpgrade = useServerFn(upgradeComputer);
  const readUpgrade = useServerFn(readComputerUpgradeStatus);

  return (
    <ComputerDetail
      key={computerId}
      computer={computer}
      timeZone={timeZone}
      onRestart={(requestId) => requestRestart({ data: { computerId, requestId } })}
      onReadRestartStatus={(requestId) => readRestart({ data: { computerId, requestId } })}
      latestComputerVersion={latestComputerVersion}
      onUpgrade={(requestId) => requestUpgrade({ data: { computerId, requestId } })}
      onReadUpgradeStatus={async (requestId) => {
        const status = await readUpgrade({ data: { computerId, requestId } });
        // A completed upgrade changes the version the list and the meta line show.
        if (status.status === "completed") await router.invalidate({ sync: true });
        return status;
      }}
      onUpdateDisplayName={async (displayName) => {
        await updateDisplayName({ data: { computerId, displayName } });
        await router.invalidate({ sync: true });
      }}
      onSetRuntimePublic={async (runtimeId, isPublic) => {
        await setVisibility({ data: { runtimeId, isPublic } });
        await router.invalidate({ sync: true });
      }}
    />
  );
}
