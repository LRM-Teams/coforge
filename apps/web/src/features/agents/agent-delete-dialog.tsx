import { useState } from "react";
import { AlertCircle, XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { m } from "@/paraglide/messages";
import { isAppError } from "@/lib/app-error";
import { useSubmitGuard } from "@/hooks/use-submit-guard";

/**
 * The Agent deletion confirmation (ADR 0044). Deleting an Agent is destructive and irreversible
 * from the UI, so it is confirmed by typing the Agent's username — the same name-confirmed shape
 * `ProjectSettings` uses for a project — rather than a bare confirm dialog. The server re-checks
 * the typed name against the Agent's current row, so this is a real guard, not only UI gating.
 */
export function AgentDeleteDialog({
  agentName,
  open,
  onOpenChange,
  onDelete,
}: {
  /** The Agent's `name` (its `@handle`), which is what the user must type to confirm. */
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Performs the delete; throws when the server refuses it. */
  onDelete: (confirmation: string) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [deleting, guard] = useSubmitGuard();
  const confirmed = confirmation.trim() === agentName;

  function submit() {
    if (!confirmed || deleting) return;
    setError("");
    void guard(async () => {
      try {
        await onDelete(confirmation.trim());
      } catch (cause) {
        setError(
          isAppError(cause) && cause.code === "ACCESS_DENIED"
            ? m.agent_delete_access_denied()
            : isAppError(cause) && cause.errorId === "agent-delete-protected"
              ? m.agent_delete_protected()
              : m.agent_delete_error(),
        );
      }
    });
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (deleting) return;
        if (!nextOpen) setConfirmation("");
        setError("");
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="overflow-hidden text-left" data-agent-delete-dialog>
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                <Heading
                  slot="title"
                  className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-2xl"
                >
                  {m.agent_delete_dialog_title({ name: agentName })}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  isDisabled={deleting}
                  onClick={close}
                />
              </div>
              <div className="mx-6 mt-4 flex items-start gap-3">
                <FeaturedIcon color="error" theme="light" size="sm" icon={AlertCircle} />
                <Text slot="description" className="text-sm text-secondary">
                  {m.agent_delete_dialog_description()}
                </Text>
              </div>
              <label className="grid gap-1 px-6 pt-5 text-sm font-medium">
                {m.agent_delete_confirm()}
                <Input
                  autoFocus
                  value={confirmation}
                  onChange={setConfirmation}
                  placeholder={m.agent_delete_placeholder()}
                  isDisabled={deleting}
                  aria-label={m.agent_delete_confirm()}
                />
              </label>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={deleting} onPress={close}>
                  {m.controls_cancel()}
                </Button>
                <Button
                  color="primary-destructive"
                  data-agent-delete-confirm
                  isDisabled={!confirmed || deleting}
                  isLoading={deleting}
                  showTextWhileLoading
                  onPress={submit}
                >
                  {deleting ? m.agent_delete_pending() : m.agent_delete_submit()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
