import { useEffect, useState } from "react";
import { AlertCircle } from "@untitledui/icons";
import { Text } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { DialogHeader } from "@/components/application/modals/dialog-header";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";
import { isAppError } from "@/lib/app-error";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import type { AgentVisibilityChangePreview } from "@/server/db/repositories/agent-visibility-change.repositories.server";
import type { AgentVisibility } from "./agent-visibility";

/**
 * The visibility-change confirmation (ADR 0059): public→private lists consequences (channels it
 * will leave, existing DMs becoming read-only, Tasks staying assigned) fetched from
 * `previewAgentVisibilityChange`; private→public confirms inline with a static note about
 * private-period Activity becoming visible — no preview fetch, since nothing becomes read-only in
 * that direction. Errors render inline with the real reason; a success toast is the caller's job
 * once `onConfirm` resolves (toast vs inline rule).
 */
export function AgentVisibilityConfirmDialog({
  agentName,
  target,
  open,
  onOpenChange,
  onLoadPreview,
  onConfirm,
}: {
  agentName: string;
  /** The visibility this confirmation would apply. */
  target: AgentVisibility;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only called (and awaited) when `target === "private"`, right after the dialog opens. */
  onLoadPreview: () => Promise<AgentVisibilityChangePreview>;
  /** Performs the change; throws when the server refuses it. */
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [submitting, guard] = useSubmitGuard();
  const [preview, setPreview] = useState<AgentVisibilityChangePreview | undefined>(undefined);
  const [previewFailed, setPreviewFailed] = useState(false);
  const goingPrivate = target === "private";

  useEffect(() => {
    if (!open || !goingPrivate) return;
    setPreview(undefined);
    setPreviewFailed(false);
    let cancelled = false;
    void onLoadPreview()
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // `onLoadPreview` is recreated per render by the caller; only `open`/`goingPrivate` should
    // re-trigger the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goingPrivate]);

  function submit() {
    if (submitting) return;
    setError("");
    void guard(async () => {
      try {
        await onConfirm();
        onOpenChange(false);
      } catch (cause) {
        setError(
          isAppError(cause) && cause.code === "ACCESS_DENIED"
            ? m.agent_visibility_change_access_denied()
            : m.agent_visibility_change_error(),
        );
      }
    });
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (submitting) return;
        setError("");
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <DialogHeader
                title={
                  goingPrivate
                    ? m.agent_visibility_confirm_private_title({ name: agentName })
                    : m.agent_visibility_confirm_public_title({ name: agentName })
                }
                onClose={submitting ? undefined : close}
              />
              <div className="mx-6 mt-4 flex items-start gap-3">
                <FeaturedIcon
                  color={goingPrivate ? "warning" : "brand"}
                  theme="light"
                  size="sm"
                  icon={AlertCircle}
                />
                <div className="min-w-0 text-sm text-secondary">
                  {goingPrivate ? (
                    <div className="grid gap-2">
                      <Text slot="description">{m.agent_visibility_confirm_private_intro()}</Text>
                      {previewFailed ? (
                        <p className="text-tertiary">{m.agent_visibility_change_error()}</p>
                      ) : !preview ? (
                        <div className="grid gap-1.5" aria-hidden="true">
                          <Skeleton className="h-4 w-full" />
                          <Skeleton className="h-4 w-2/3" />
                        </div>
                      ) : (
                        <ul className="list-disc space-y-1 pl-5 text-secondary">
                          <li>
                            {preview.channelNames.length > 0
                              ? m.agent_visibility_confirm_private_channels({
                                  count: preview.channelNames.length,
                                  names: preview.channelNames.map((name) => `#${name}`).join(", "),
                                })
                              : m.agent_visibility_confirm_private_no_channels()}
                          </li>
                          <li>
                            {preview.readOnlyDirectMessageCount > 0
                              ? m.agent_visibility_confirm_private_dms({
                                  count: preview.readOnlyDirectMessageCount,
                                })
                              : m.agent_visibility_confirm_private_no_dms()}
                          </li>
                          <li>{m.agent_visibility_confirm_private_tasks()}</li>
                        </ul>
                      )}
                    </div>
                  ) : (
                    <Text slot="description">{m.agent_visibility_confirm_public_body()}</Text>
                  )}
                </div>
              </div>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={submitting} onPress={close}>
                  {m.controls_cancel()}
                </Button>
                <Button
                  color={goingPrivate ? "primary-destructive" : "primary"}
                  isDisabled={submitting}
                  isLoading={submitting}
                  showTextWhileLoading
                  onPress={submit}
                >
                  {submitting
                    ? goingPrivate
                      ? m.agent_visibility_confirm_private_pending()
                      : m.agent_visibility_confirm_public_pending()
                    : goingPrivate
                      ? m.agent_visibility_confirm_private_submit()
                      : m.agent_visibility_confirm_public_submit()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
