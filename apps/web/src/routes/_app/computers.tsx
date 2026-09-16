import { useState } from "react";
import { Outlet, createFileRoute, getRouteApi, useParams } from "@tanstack/react-router";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { useAppToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
import { describeComputerUpgradeFailure } from "@/features/computers/upgrade-failure";

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
  const [upgradingComputerId, setUpgradingComputerId] = useState<string>();
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
        upgradingComputerId={upgradingComputerId}
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
                  setUpgradeComputerId(undefined);
                  // While the operation runs, the control itself is the only progress this page
                  // shows; stages, request IDs, and timings stay in the logs and result files.
                  setUpgradingComputerId(computerId);
                  try {
                    const accepted = await requestUpgrade({ data: { computerId, requestId } });
                    if (accepted.status !== "accepted") return;
                    for (let poll = 0; poll < 31; poll += 1) {
                      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
                      const status = await readUpgradeStatus({ data: { computerId, requestId } });
                      if (status.status === "completed" && status.computerVersion) {
                        toast.success(
                          m.computer_upgrade_succeeded({ version: status.computerVersion }),
                        );
                        return;
                      }
                      if (status.status === "completed")
                        throw new Error(describeComputerUpgradeFailure({ reason: "evidence" }));
                      if (status.status === "failed")
                        throw new Error(describeComputerUpgradeFailure(status));
                    }
                    throw new Error(describeComputerUpgradeFailure({ reason: "timeout" }));
                  } catch (error) {
                    console.error("Computer upgrade was not verified", error);
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : describeComputerUpgradeFailure({ reason: "timeout" }),
                    );
                  } finally {
                    // The control returns to its ordinary state, which is also the retry.
                    setUpgradingComputerId(undefined);
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
