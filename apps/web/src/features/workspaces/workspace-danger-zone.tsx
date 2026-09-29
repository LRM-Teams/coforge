import { useState, type FC, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";
import { AlertTriangle, LogOut01, Trash01 } from "@untitledui/icons";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import {
  SaveErrorMessage,
  saveErrorFrom,
  SettingsCard,
  SettingsGroup,
  type SaveError,
} from "#src/components/settings-content";
import { isAppError, type AppError, type AppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { leaveWorkspace } from "./members.functions";
import { canDeleteWorkspace } from "./workspace-roles";
import { deleteWorkspace } from "./workspaces.functions";

type DialogProps = { open: boolean; workspaceName: string; onClose: () => void };

/**
 * Settings → Workspace profile → Danger zone: its owner deletes the Workspace, everyone else
 * leaves it.
 */
export function WorkspaceDangerZone({
  workspaceName,
  workspaceSlug,
  actorRole,
}: {
  workspaceName: string;
  workspaceSlug: string;
  actorRole: string;
}) {
  const [open, setOpen] = useState(false);
  const owner = canDeleteWorkspace(actorRole);
  const dialog = { open, workspaceName, onClose: () => setOpen(false) };
  const action = owner
    ? {
        title: m.settings_delete_workspace(),
        description: m.settings_delete_workspace_description(),
        icon: Trash01,
      }
    : // Only a new invitation undoes leaving, so it is a destructive action too (docs/design).
      {
        title: m.settings_leave_workspace(),
        description: m.settings_leave_workspace_description(),
        icon: LogOut01,
      };

  return (
    <SettingsGroup icon={AlertTriangle} label={m.settings_danger_zone()}>
      <SettingsCard>
        <DangerAction {...action} onPress={() => setOpen(true)} />
      </SettingsCard>
      {owner ? (
        <DeleteWorkspaceDialog {...dialog} workspaceSlug={workspaceSlug} />
      ) : (
        <LeaveWorkspaceDialog {...dialog} />
      )}
    </SettingsGroup>
  );
}

function DangerAction({
  title,
  description,
  icon,
  onPress,
}: {
  title: string;
  description: string;
  icon: FC<{ className?: string }>;
  onPress: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
        <p className="mt-1 text-sm text-tertiary">{description}</p>
      </div>
      <Button
        color="secondary-destructive"
        iconLeading={icon}
        className="shrink-0 self-start sm:self-auto"
        onPress={onPress}
      >
        {title}
      </Button>
    </div>
  );
}

/**
 * The viewer's departure from the Workspace: runs the write that takes them out (leave, delete),
 * then opens the Workspace the server picked, or `/` when there is none. A refusal whose code says
 * they are out already goes to `/` too; any other failure stays inline as `error`.
 */
function useWorkspaceDeparture({
  write,
  outAlready,
  messageFor,
}: {
  write: () => Promise<{ nextWorkspaceSlug: string | null }>;
  outAlready: readonly AppErrorCode[];
  /** The inline copy for a failure; `refusal` is absent when the server gave no reason. */
  messageFor: (refusal: AppError | undefined) => string;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);

  async function depart() {
    setBusy(true);
    setError(null);
    let next: string | null;
    try {
      next = (await write()).nextWorkspaceSlug;
    } catch (cause) {
      const refusal = isAppError(cause) ? cause : undefined;
      if (!refusal || !outAlready.includes(refusal.code)) {
        setError(saveErrorFrom(messageFor(refusal), cause));
        setBusy(false);
        return;
      }
      next = null;
    }
    try {
      if (next) await navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug: next } });
      else await navigate({ to: "/" });
    } finally {
      // Still here when the navigation failed: trying again finds them out already and goes to `/`.
      setBusy(false);
    }
  }

  return { busy, error, depart, clearError: () => setError(null) };
}

/** Confirms leaving; the write runs here so a failure stays inline. */
function LeaveWorkspaceDialog({ open, workspaceName, onClose }: DialogProps) {
  const leave = useServerFn(leaveWorkspace);
  const { busy, error, depart, clearError } = useWorkspaceDeparture({
    write: () => leave(),
    // No longer a member (removed meanwhile): they are out already.
    outAlready: ["NOT_FOUND", "ACCESS_DENIED"],
    messageFor: (refusal) =>
      refusal?.code === "CONFLICT"
        ? m.settings_leave_workspace_owner()
        : m.settings_leave_workspace_error(),
  });

  return (
    <DangerDialog
      open={open}
      busy={busy}
      title={m.settings_leave_workspace()}
      description={m.settings_leave_workspace_confirm({ name: workspaceName })}
      error={error}
      onClose={() => {
        clearError();
        onClose();
      }}
      confirmLabel={busy ? m.settings_leave_workspace_leaving() : m.settings_leave_workspace()}
      onConfirm={() => void depart()}
    />
  );
}

/** What a refused delete says, by the refusal's `errorId`, else its code. */
function deleteRefusalMessage(refusal: AppError | undefined, slug: string) {
  if (refusal?.errorId === "workspace-memory-bound")
    return m.settings_delete_workspace_memory_bound();
  if (refusal?.errorId === "workspace-memory-cleanup-pending")
    return m.settings_delete_workspace_memory_cleanup();
  if (refusal?.code === "INVALID_INPUT") return m.settings_delete_workspace_mismatch({ slug });
  if (refusal?.code === "ACCESS_DENIED") return m.settings_delete_workspace_denied();
  return m.settings_delete_workspace_error();
}

/** Confirms deleting with the Workspace's slug typed exactly; the server checks it again. */
function DeleteWorkspaceDialog({
  open,
  workspaceName,
  workspaceSlug,
  onClose,
}: DialogProps & { workspaceSlug: string }) {
  const remove = useServerFn(deleteWorkspace);
  const [typed, setTyped] = useState("");
  const { busy, error, depart, clearError } = useWorkspaceDeparture({
    write: () => remove({ data: { confirmSlug: typed } }),
    // Deleted from another tab meanwhile.
    outAlready: ["NOT_FOUND"],
    messageFor: (refusal) => deleteRefusalMessage(refusal, workspaceSlug),
  });

  return (
    <DangerDialog
      open={open}
      busy={busy}
      title={m.settings_delete_workspace()}
      description={m.settings_delete_workspace_confirm({ name: workspaceName })}
      error={error}
      onClose={() => {
        setTyped("");
        clearError();
        onClose();
      }}
      confirmLabel={busy ? m.settings_delete_workspace_deleting() : m.settings_delete_workspace()}
      isConfirmDisabled={typed !== workspaceSlug}
      onConfirm={() => void depart()}
    >
      <div className="mx-6 mt-4">
        <Input
          label={m.settings_delete_workspace_type_slug({ slug: workspaceSlug })}
          placeholder={workspaceSlug}
          autoFocus
          autoComplete="off"
          spellCheck="false"
          inputClassName="font-mono"
          value={typed}
          onChange={setTyped}
          isDisabled={busy}
        />
      </div>
    </DangerDialog>
  );
}

/** A destructive confirmation: its one solid red button confirms, and it cannot be dismissed while
 * the write runs. Enter in a field confirms too, when the confirm button is enabled. */
function DangerDialog({
  open,
  busy,
  title,
  description,
  error,
  onClose,
  confirmLabel,
  isConfirmDisabled = false,
  onConfirm,
  children,
}: {
  open: boolean;
  busy: boolean;
  title: string;
  description: string;
  error: SaveError | null;
  onClose: () => void;
  confirmLabel: string;
  isConfirmDisabled?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (next || busy) return;
        onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <form
              className="contents"
              onSubmit={(event) => {
                event.preventDefault();
                if (!isConfirmDisabled && !busy) onConfirm();
              }}
            >
              <DialogHeader title={title} onClose={busy ? undefined : close} />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {description}
              </Text>
              {children}
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
                  type="submit"
                  color="primary-destructive"
                  isDisabled={busy || isConfirmDisabled}
                  isLoading={busy}
                  showTextWhileLoading
                >
                  {confirmLabel}
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
