import { useState } from "react";
import {
  AlertCircle,
  Play,
  RefreshCcw01 as RotateCcw,
  StopSquare,
  XClose as X,
} from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";

type AgentControlRequest = {
  agentId: string;
  action: "start" | "stop" | "restart" | "reset-session" | "full-reset";
  requestId: string;
  confirmed?: boolean;
};

export function AgentControl({
  agentId,
  agentName,
  /** Raft `resetAgentWorkspace`: Workspace owner/admin only. Restart and Reset session need only
   * `controlAgentRuntime`, held by any current Workspace member, so they are always offered here;
   * the server is still the authority (AgentControl.execute()). */
  canFullReset,
  onExecute,
  /** `agentDisplay(display).isOnline`: chooses Stop (online, including an errored Agent) or Start
   * (offline). The live display, not a separate subscription (ADR 0038). */
  isOnline,
  /** The assigned Computer's last-known connection state from existing page data; not a new
   * realtime subscription. `undefined` (no Computer, or unknown) shows no note. */
  computerOnline,
  computerLabel,
}: {
  agentId: string;
  agentName: string;
  canFullReset: boolean;
  onExecute: (request: AgentControlRequest) => Promise<void>;
  isOnline?: boolean;
  computerOnline?: boolean;
  computerLabel?: string;
}) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"restart" | "reset-session" | "full-reset">("restart");
  const options = [
    {
      action: "restart",
      label: m.agent_control_restart(),
      description: m.agent_control_restart_description(),
    },
    {
      action: "reset-session",
      label: m.agent_control_reset_session(),
      description: m.agent_control_reset_session_description(),
    },
    ...(canFullReset
      ? ([
          {
            action: "full-reset",
            label: m.agent_control_full_reset(),
            description: m.agent_control_full_reset_description(),
          },
        ] as const)
      : []),
  ] as const;
  const selected = options.find((option) => option.action === action)!;
  const destructive = action === "full-reset";

  function submit() {
    setOpen(false);
    setSubmitError(null);
    void onExecute({
      agentId,
      action,
      requestId: crypto.randomUUID(),
      ...(destructive && { confirmed: true }),
    }).catch((cause: unknown) => {
      setSubmitError(
        isAppError(cause) && cause.code === "ACCESS_DENIED"
          ? m.agent_control_access_denied()
          : m.agent_control_submit_error(),
      );
    });
  }

  const [startPending, guardStart] = useSubmitGuard();
  const [stopPending, guardStop] = useSubmitGuard();
  const [startStopError, setStartStopError] = useState<string | null>(null);
  const [startDeferred, setStartDeferred] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const startStopBusy = startPending || stopPending;

  function startStopFailureMessage(cause: unknown) {
    return isAppError(cause) && cause.code === "ACCESS_DENIED"
      ? m.agent_control_access_denied()
      : m.agent_control_submit_error();
  }

  function submitStart() {
    setStartStopError(null);
    setStartDeferred(false);
    void guardStart(async () => {
      try {
        await onExecute({ agentId, action: "start", requestId: crypto.randomUUID() });
        // A Computer known to be offline never got the Start; the persisted intent (ADR 0038)
        // still resumes it at the next Daemon `ready`, so this is a note, not a failure.
        if (computerOnline === false) setStartDeferred(true);
      } catch (cause) {
        setStartStopError(startStopFailureMessage(cause));
      }
    });
  }

  function confirmStop() {
    setStartStopError(null);
    void guardStop(async () => {
      try {
        await onExecute({ agentId, action: "stop", requestId: crypto.randomUUID() });
        setStopConfirmOpen(false);
      } catch (cause) {
        setStartStopError(startStopFailureMessage(cause));
      }
    });
  }

  return (
    <section className="py-6" data-agent-control>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-semibold">{m.agent_control_title()}</h2>
        <div className="flex items-center gap-2">
          <Button
            color="secondary"
            data-control-start-stop
            isDisabled={startStopBusy}
            onPress={() => {
              setStartStopError(null);
              if (isOnline) {
                setStartDeferred(false);
                setStopConfirmOpen(true);
                return;
              }
              submitStart();
            }}
          >
            {isOnline ? <StopSquare aria-hidden="true" /> : <Play aria-hidden="true" />}
            {isOnline
              ? stopPending
                ? m.agent_control_stop_pending()
                : m.agent_control_stop()
              : startPending
                ? m.agent_control_start_pending()
                : m.agent_control_start()}
          </Button>
          <Button
            color="secondary"
            onPress={() => {
              setAction("restart");
              setOpen(true);
            }}
          >
            <RotateCcw aria-hidden="true" />
            {m.agent_control_restart()}
          </Button>
        </div>
      </div>
      {startStopError && (
        <p className="mt-4 text-sm text-error-primary" role="alert">
          {startStopError}
        </p>
      )}
      {!startStopError && startDeferred && computerLabel && (
        <p className="mt-4 text-sm text-tertiary">
          {m.agent_control_start_deferred_notice({ computer: computerLabel })}
        </p>
      )}
      {submitError && (
        <p className="mt-4 text-sm text-error-primary" role="alert">
          {submitError}
        </p>
      )}
      <ModalOverlay
        isOpen={stopConfirmOpen}
        onOpenChange={(nextOpen: boolean) => {
          if (stopPending) return;
          setStopConfirmOpen(nextOpen);
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog className="overflow-hidden text-left">
            {({ close }) => (
              <>
                <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                  <Heading
                    slot="title"
                    className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-2xl"
                  >
                    {m.agent_control_stop_dialog_title()}
                  </Heading>
                  <ButtonUtility
                    aria-label={m.controls_close()}
                    icon={X}
                    size="sm"
                    color="tertiary"
                    isDisabled={stopPending}
                    onClick={close}
                  />
                </div>
                <Text slot="description" className="px-6 pt-4 text-sm text-tertiary">
                  {m.agent_control_stop_message({ name: agentName })}
                </Text>
                {startStopError && (
                  <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                    {startStopError}
                  </p>
                )}
                <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                  <Button color="secondary" isDisabled={stopPending} onPress={close}>
                    {m.controls_cancel()}
                  </Button>
                  <Button
                    color="primary"
                    data-control-stop-confirm
                    isDisabled={stopPending}
                    onPress={confirmStop}
                  >
                    <StopSquare aria-hidden="true" />
                    {stopPending ? m.agent_control_stop_pending() : m.agent_control_stop_confirm()}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <ModalOverlay isOpen={open} onOpenChange={setOpen}>
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog className="overflow-hidden text-left">
            {({ close }) => (
              <>
                <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                  <Heading
                    slot="title"
                    className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-2xl"
                  >
                    {m.agent_control_dialog_title({ name: agentName })}
                  </Heading>
                  <ButtonUtility
                    aria-label={m.controls_close()}
                    icon={X}
                    size="sm"
                    color="tertiary"
                    onClick={close}
                  />
                </div>
                <Text slot="description" className="sr-only">
                  {selected.description}
                </Text>
                <div
                  className="grid min-h-0 gap-3 overflow-y-auto px-6 py-6"
                  role="group"
                  aria-label={m.agent_control_title()}
                >
                  {options.map((option) => (
                    <Button
                      key={option.action}
                      color="secondary"
                      aria-label={option.label}
                      aria-pressed={action === option.action}
                      data-control-action={option.action}
                      className={`h-auto flex-col items-start whitespace-normal rounded-xl p-4 text-left ${action === option.action ? (destructive ? "border-error bg-error-primary ring-1 ring-error hover:bg-error-primary" : "border-brand bg-primary ring-1 ring-brand hover:bg-primary") : "hover:bg-secondary"}`}
                      onPress={() => setAction(option.action)}
                    >
                      <span className="font-semibold">{option.label}</span>
                      <span className="mt-1 text-sm font-normal leading-6 text-tertiary">
                        {option.description}
                      </span>
                    </Button>
                  ))}
                  {destructive && (
                    <div
                      className="flex items-start gap-3 rounded-lg border border-error_subtle bg-error-primary p-4 text-sm text-error-primary"
                      role="alert"
                    >
                      <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                      <p>{m.agent_control_confirm_description()}</p>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                  <Button color="secondary" onPress={close}>
                    {m.controls_cancel()}
                  </Button>
                  <Button
                    color={destructive ? "primary-destructive" : "primary"}
                    data-control-submit
                    onPress={submit}
                  >
                    <RotateCcw aria-hidden="true" />
                    {selected.label}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  );
}
