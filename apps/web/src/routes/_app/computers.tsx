import { useState } from "react";
import { Outlet, createFileRoute, getRouteApi, useParams } from "@tanstack/react-router";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { useAppToast } from "@/components/ui/toast";

import { AddComputerDialog } from "@/features/computers/add-computer-dialog";
import { ComputerLayout } from "@/features/computers/computer-layout";
import { ComputersPending } from "@/features/computers/computers-pending";
import {
  getLatestComputerVersion,
  listComputers,
  readComputerUpgradeStatus,
  upgradeComputer,
} from "@/features/computers/computers.functions";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getInstallOrigin } from "@/features/install/install.functions";
import { getUserPreferences } from "@/features/settings/settings.functions";
import { useServerFn } from "@tanstack/react-start";

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
  const [upgradeComputerId, setUpgradeComputerId] = useState<string>();
  const requestUpgrade = useServerFn(upgradeComputer);
  const readUpgradeStatus = useServerFn(readComputerUpgradeStatus);
  const toast = useAppToast();

  return (
    <>
      <ComputerLayout
        computers={computers}
        selectedComputerId={params?.computerId}
        onAdd={() => setAddComputerOpen(true)}
        latestComputerVersion={latestComputerVersion}
        onComputerUpdate={(computer) => {
          if (!computer.ownedByCurrentUser) return;
          setUpgradeComputerId(computer.id);
        }}
      >
        <Outlet />
      </ComputerLayout>
      <AddComputerDialog
        open={addComputerOpen}
        onOpenChange={setAddComputerOpen}
        installOrigin={installOrigin}
        workspaceSlug={currentWorkspace?.slug ?? null}
      />
      <ModalOverlay
        isOpen={upgradeComputerId !== undefined}
        onOpenChange={(open) => {
          if (!open) setUpgradeComputerId(undefined);
        }}
      >
        <Modal>
          <Dialog aria-labelledby="computer-upgrade-title" className="p-6">
            <h2 id="computer-upgrade-title" className="text-lg font-semibold">
              Upgrade Computer?
            </h2>
            <p className="mt-2 text-sm text-tertiary">
              The Computer and its Daemon will restart. The upgrade is only reported successful
              after the new version and process identity are observed.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button color="tertiary" onPress={() => setUpgradeComputerId(undefined)}>
                Cancel
              </Button>
              <Button
                color="primary"
                onPress={async () => {
                  const computerId = upgradeComputerId;
                  if (!computerId) return;
                  const requestId = crypto.randomUUID();
                  try {
                    const accepted = await requestUpgrade({ data: { computerId, requestId } });
                    setUpgradeComputerId(undefined);
                    if (accepted.status !== "accepted") return;
                    for (let poll = 0; poll < 31; poll += 1) {
                      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
                      const status = await readUpgradeStatus({ data: { computerId, requestId } });
                      if (
                        status.status === "completed" &&
                        status.computerVersion &&
                        status.daemonVersion &&
                        status.workerInstanceId
                      ) {
                        toast.success(
                          `Computer ${status.computerVersion} / Daemon ${status.daemonVersion} ready (${status.workerInstanceId})`,
                        );
                        return;
                      }
                      if (status.status === "completed")
                        throw new Error("upgrade evidence incomplete");
                      if (status.status === "failed") throw new Error(status.reason);
                    }
                    throw new Error("upgrade completion is unknown");
                  } catch (error) {
                    console.error("Computer upgrade was not verified", error);
                  }
                }}
              >
                Upgrade
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
