import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";
import { AlertTriangle, LogOut01 } from "@untitledui/icons";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import {
  SaveErrorMessage,
  saveErrorFrom,
  SettingsCard,
  SettingsGroup,
  type SaveError,
} from "#src/components/settings-content";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { leaveWorkspace } from "./members.functions";
import { canLeaveWorkspace } from "./workspace-roles";

/**
 * Settings → Workspace profile → Danger zone: leaving the Workspace, for everyone but its owner.
 * Absent for the owner, who cannot leave, until the Workspace can be deleted from here.
 */
export function WorkspaceDangerZone({
  workspaceName,
  actorRole,
}: {
  workspaceName: string;
  actorRole: string;
}) {
  const [leaving, setLeaving] = useState(false);
  if (!canLeaveWorkspace(actorRole)) return null;

  return (
    <SettingsGroup icon={AlertTriangle} label={m.settings_danger_zone()}>
      <SettingsCard>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-primary">{m.settings_leave_workspace()}</h3>
            <p className="mt-1 text-sm text-tertiary">{m.settings_leave_workspace_description()}</p>
          </div>
          {/* Only a new invitation undoes leaving, so it is a destructive action (docs/design). */}
          <Button
            color="secondary-destructive"
            iconLeading={LogOut01}
            className="shrink-0 self-start sm:self-auto"
            onPress={() => setLeaving(true)}
          >
            {m.settings_leave_workspace()}
          </Button>
        </div>
      </SettingsCard>
      <LeaveWorkspaceDialog
        open={leaving}
        workspaceName={workspaceName}
        onClose={() => setLeaving(false)}
      />
    </SettingsGroup>
  );
}

/** Confirms leaving; the write runs here so a failure stays inline, and success opens the next
 * Workspace the server picked (or `/` when there is none). */
function LeaveWorkspaceDialog({
  open,
  workspaceName,
  onClose,
}: {
  open: boolean;
  workspaceName: string;
  onClose: () => void;
}) {
  const leave = useServerFn(leaveWorkspace);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    let next: string | null;
    try {
      next = (await leave()).nextWorkspaceSlug;
    } catch (cause) {
      const code = isAppError(cause) ? cause.code : undefined;
      // No longer a member (removed meanwhile): they are out already, and `/` finds where to go.
      if (code === "NOT_FOUND" || code === "ACCESS_DENIED") next = null;
      else {
        const message =
          code === "CONFLICT"
            ? m.settings_leave_workspace_owner()
            : m.settings_leave_workspace_error();
        setError(saveErrorFrom(message, cause));
        setBusy(false);
        return;
      }
    }
    if (next) await navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug: next } });
    else await navigate({ to: "/" });
  }

  return (
    <ModalOverlay
      isOpen={open}
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (next || busy) return;
        setError(null);
        onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <DialogHeader
                title={m.settings_leave_workspace()}
                onClose={busy ? undefined : close}
              />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {m.settings_leave_workspace_confirm({ name: workspaceName })}
              </Text>
              {error && (
                <div className="px-6 pt-4">
                  <SaveErrorMessage error={error} />
                </div>
              )}
              <div className="mt-6 flex justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={busy} onPress={close}>
                  {m.controls_cancel()}
                </Button>
                <Button
                  color="primary-destructive"
                  isDisabled={busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={() => void confirm()}
                >
                  {busy ? m.settings_leave_workspace_leaving() : m.settings_leave_workspace()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
