import { Play, RefreshCcw01 as RotateCcw, StopSquare } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import { AgentControlDialogs } from "./agent-control-dialogs";
import { useAgentRuntimeControls, type AgentControlExecute } from "./agent-runtime-controls";

export type { AgentControlExecute, AgentControlRequest } from "./agent-runtime-controls";

/** The Agent detail page's Start/Stop + Restart controls, its confirm dialogs and inline errors,
 * built on `useAgentRuntimeControls`. The Agent profile panel drives the same hook and the same
 * `AgentControlDialogs` from its own header icon buttons and Actions section instead of rendering
 * this component (ADR 0038 "Consequences": the panel is a documented follow-up). */
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
  onExecute: AgentControlExecute;
  isOnline?: boolean;
  computerOnline?: boolean;
  computerLabel?: string;
}) {
  const controls = useAgentRuntimeControls({
    agentId,
    agentName,
    canFullReset,
    onExecute,
    isOnline,
    computerOnline,
    computerLabel,
  });
  return (
    <section className="py-6" data-agent-control>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-semibold">{m.agent_control_title()}</h2>
        <div className="flex items-center gap-2">
          <Button
            color="secondary"
            data-control-start-stop
            isDisabled={controls.startStopBusy}
            onPress={controls.pressStartOrStop}
          >
            {controls.isOnline ? <StopSquare aria-hidden="true" /> : <Play aria-hidden="true" />}
            {controls.isOnline
              ? controls.stopPending
                ? m.agent_control_stop_pending()
                : m.agent_control_stop()
              : controls.startPending
                ? m.agent_control_start_pending()
                : m.agent_control_start()}
          </Button>
          <Button color="secondary" onPress={() => controls.openRestart("restart")}>
            <RotateCcw aria-hidden="true" />
            {m.agent_control_restart()}
          </Button>
        </div>
      </div>
      {controls.startStopError && (
        <p className="mt-4 text-sm text-error-primary" role="alert">
          {controls.startStopError}
        </p>
      )}
      {!controls.startStopError && controls.startDeferred && controls.computerLabel && (
        <p className="mt-4 text-sm text-tertiary">
          {m.agent_control_start_deferred_notice({ computer: controls.computerLabel })}
        </p>
      )}
      {controls.restartSubmitError && (
        <p className="mt-4 text-sm text-error-primary" role="alert">
          {controls.restartSubmitError}
        </p>
      )}
      <AgentControlDialogs agentName={agentName} control={controls} />
    </section>
  );
}
