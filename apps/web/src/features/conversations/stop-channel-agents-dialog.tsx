import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { stopChannelAgents } from "./channels.functions";

type Outcome = { stopped: number; failed: number };

/**
 * "Stop all Agents" for one channel: a confirmation, then what the stop did. Stopping is not
 * permanent (each Agent starts again from its profile), so the confirm button is not red. Mount
 * it only while it is open, so each opening starts at the confirmation.
 */
export function StopChannelAgentsDialog({
  channelId,
  channelName,
  onClose,
}: {
  channelId: string;
  channelName: string;
  onClose: () => void;
}) {
  const stop = useServerFn(stopChannelAgents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      setOutcome(await stop({ data: { channelId } }));
    } catch (cause) {
      const code = isAppError(cause) ? cause.code : undefined;
      setError(
        code === "CONFLICT"
          ? m.channel_stop_agents_archived()
          : code === "ACCESS_DENIED"
            ? m.channel_stop_agents_denied()
            : code === "NOT_FOUND"
              ? m.channel_stop_agents_gone()
              : m.channel_stop_agents_error(),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay
      isOpen
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (next || busy) return;
        onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <DialogHeader
                title={
                  outcome === null
                    ? m.channel_stop_agents_title()
                    : outcome.failed === 0
                      ? m.channel_stop_agents_done_title()
                      : m.channel_stop_agents_partial_title()
                }
                onClose={busy ? undefined : close}
              />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {outcome === null
                  ? m.channel_stop_agents_confirm({ name: channelName })
                  : outcome.failed === 0
                    ? m.channel_stop_agents_done()
                    : m.channel_stop_agents_partial({
                        failed: outcome.failed,
                        total: outcome.stopped + outcome.failed,
                      })}
              </Text>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-3 border-t border-secondary px-6 py-4">
                {outcome?.failed === 0 ? (
                  <Button color="secondary" onPress={close}>
                    {m.channel_stop_agents_keep_stopped()}
                  </Button>
                ) : outcome ? (
                  <>
                    <Button color="secondary" isDisabled={busy} onPress={close}>
                      {m.controls_close()}
                    </Button>
                    <Button
                      isDisabled={busy}
                      isLoading={busy}
                      showTextWhileLoading
                      onPress={() => void confirm()}
                    >
                      {busy ? m.channel_stop_agents_stopping() : m.channel_stop_agents_retry()}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button color="secondary" isDisabled={busy} onPress={close}>
                      {m.channel_settings_cancel()}
                    </Button>
                    <Button
                      isDisabled={busy}
                      isLoading={busy}
                      showTextWhileLoading
                      onPress={() => void confirm()}
                    >
                      {busy ? m.channel_stop_agents_stopping() : m.channel_stop_agents_action()}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
