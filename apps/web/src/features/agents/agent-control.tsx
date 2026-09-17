import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  RefreshCcw01 as RotateCcw,
  XClose as X,
} from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";

type AgentControlRequest = {
  agentId: string;
  action: "restart" | "reset-session" | "full-reset";
  requestId: string;
  confirmed?: boolean;
};

/** Known non-fatal control warning codes; never render a raw code (toast-vs-inline-rule). */
function warningMessage(code: string): string | undefined {
  if (code === "workspace_clear_incomplete")
    return m.agent_control_warning_workspace_clear_incomplete();
  return undefined;
}

export function AgentControl({
  agentId,
  agentName,
  /** Raft `resetAgentWorkspace`: Workspace owner/admin only. Restart and Reset session need only
   * `controlAgentRuntime`, held by any current Workspace member, so they are always offered here;
   * the server is still the authority (AgentControl.execute()). */
  canFullReset,
  onExecute,
}: {
  agentId: string;
  agentName: string;
  canFullReset: boolean;
  onExecute: (request: AgentControlRequest) => Promise<{ warning?: string } | void>;
}) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warningCode, setWarningCode] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<AgentControlRequest["action"]>("restart");
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
    setWarningCode(undefined);
    void onExecute({
      agentId,
      action,
      requestId: crypto.randomUUID(),
      ...(destructive && { confirmed: true }),
    })
      .then((result) => setWarningCode(result?.warning))
      .catch((cause: unknown) => {
        setSubmitError(
          isAppError(cause) && cause.code === "ACCESS_DENIED"
            ? m.agent_control_access_denied()
            : m.agent_control_submit_error(),
        );
      });
  }

  return (
    <section className="py-6" data-agent-control>
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">{m.agent_control_title()}</h2>
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
      {submitError && (
        <p className="mt-4 text-sm text-error-primary" role="alert">
          {submitError}
        </p>
      )}
      {warningCode && warningMessage(warningCode) && (
        <div
          className="mt-4 flex items-start gap-3 rounded-lg border border-secondary bg-warning-primary p-3 text-sm text-primary"
          role="status"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p>{warningMessage(warningCode)}</p>
        </div>
      )}
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
