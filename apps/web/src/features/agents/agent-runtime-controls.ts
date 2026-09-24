import { useState } from "react";

import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

export type AgentControlRequest = {
  agentId: string;
  action: "start" | "stop" | "restart" | "reset-session" | "full-reset";
  requestId: string;
  confirmed?: boolean;
};

export type AgentRestartAction = "restart" | "reset-session" | "full-reset";

export type AgentControlExecute = (request: AgentControlRequest) => Promise<void>;

/**
 * The Start/Stop/Restart/Reset-session/Full-reset state machine behind Agent control,
 * extracted out of `AgentControl` so the Agent detail page and the Agent profile panel's header
 * icon buttons and Actions section can trigger the same dialogs without duplicating this logic.
 * A caller renders `StopConfirmDialog`/`RestartResetDialog` once per page/panel and wires trigger
 * buttons to the functions this hook returns.
 */
export function useAgentRuntimeControls({
  agentId,
  agentName,
  canFullReset,
  onExecute,
  isOnline,
  computerOnline,
  computerLabel,
}: {
  agentId: string;
  agentName: string;
  /** Raft `resetAgentWorkspace`: Workspace owner/admin only. Restart and Reset session need only
   * `controlAgentRuntime`, held by any current Workspace member, so they are always offered here;
   * the server is still the authority (AgentControl.execute()). */
  canFullReset: boolean;
  onExecute: AgentControlExecute;
  /** `agentDisplay(display).isOnline`: chooses Stop (online, including an errored Agent) or Start
   * (offline). The live display, not a separate subscription. */
  isOnline?: boolean;
  /** The assigned Computer's last-known connection state from existing page data; not a new
   * realtime subscription. `undefined` (no Computer, or unknown) shows no note. */
  computerOnline?: boolean;
  computerLabel?: string;
}) {
  const [restartSubmitError, setRestartSubmitError] = useState<string | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [action, setAction] = useState<AgentRestartAction>("restart");
  const options = [
    {
      action: "restart" as const,
      label: m.agent_control_restart(),
      description: m.agent_control_restart_description(),
    },
    {
      action: "reset-session" as const,
      label: m.agent_control_reset_session(),
      description: m.agent_control_reset_session_description(),
    },
    ...(canFullReset
      ? ([
          {
            action: "full-reset" as const,
            label: m.agent_control_full_reset(),
            description: m.agent_control_full_reset_description(),
          },
        ] as const)
      : []),
  ] as const;
  const selected = options.find((option) => option.action === action)!;
  const destructive = action === "full-reset";

  function openRestart(initialAction: AgentRestartAction = "restart") {
    setAction(initialAction);
    setRestartOpen(true);
  }

  function submitRestart() {
    setRestartOpen(false);
    setRestartSubmitError(null);
    void onExecute({
      agentId,
      action,
      requestId: crypto.randomUUID(),
      ...(destructive && { confirmed: true }),
    }).catch((cause: unknown) => {
      setRestartSubmitError(
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
        // A Computer known to be offline never got the Start; the persisted intent
        // still resumes it at the next Daemon `ready`, so this is a note, not a failure.
        if (computerOnline === false) setStartDeferred(true);
      } catch (cause) {
        setStartStopError(startStopFailureMessage(cause));
      }
    });
  }

  /** The header/Actions Start-or-Stop trigger: Start submits immediately, Stop opens the confirm
   * dialog. Mirrors `agentDisplay(display).isOnline`'s choice. */
  function pressStartOrStop() {
    setStartStopError(null);
    if (isOnline) {
      setStartDeferred(false);
      setStopConfirmOpen(true);
      return;
    }
    submitStart();
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

  return {
    agentName,
    isOnline,
    computerLabel,
    startPending,
    stopPending,
    startStopBusy,
    startStopError,
    startDeferred,
    pressStartOrStop,
    stopConfirmOpen,
    setStopConfirmOpen,
    /** `onOpenChange(false)` convenience for the dialog host; a no-op while a Stop is in flight. */
    closeStopConfirm: () => setStopConfirmOpen(false),
    confirmStop,
    restartOpen,
    setRestartOpen,
    /** `onOpenChange(false)` convenience for the dialog host. */
    closeRestart: () => setRestartOpen(false),
    action,
    setAction,
    options,
    selected,
    destructive,
    restartSubmitError,
    openRestart,
    submitRestart,
  };
}

export type AgentRuntimeControls = ReturnType<typeof useAgentRuntimeControls>;
