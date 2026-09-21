import {
  MessageSquare01 as MessageSquare,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
  XClose as X,
} from "@untitledui/icons";

import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { AgentActivityAvatar } from "@/features/agents/agent-activity-avatar";
import { agentDisplay } from "@/features/agents/agent-activity-presentation";
import type { AgentRuntimeControls } from "@/features/agents/agent-runtime-controls";
import { useAgentRecentActivity } from "@/features/agents/workspace-agents-realtime";
import { m } from "@/paraglide/messages";
import { localizeHref } from "@/paraglide/runtime";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

/**
 * The panel's first band (48px, the same height as Thread's header): the Agent's identity on the
 * left, bordered icon buttons on the right — Message, Start-or-Stop, Restart/Reset, then a plain
 * Close. Available on every tab (rendered once by the panel shell, not per tab). All four use the
 * official `ButtonUtility` with its `tooltip` prop.
 */
export function AgentProfileHeader({
  agent,
  display,
  timeZone,
  controls,
  onClose,
}: {
  agent: { id: string; name: string; displayName: string; description?: string };
  display?: AgentDisplaySnapshot;
  timeZone: string | null;
  controls: AgentRuntimeControls;
  onClose: () => void;
}) {
  const activity = useAgentRecentActivity(agent.id);
  // The live status line, from the same source the avatar's own label uses.
  const statusLabel = agentDisplay(display).label;
  return (
    // Same 20px gutter as the panel body (px-5): the bordered utility buttons align by box edge,
    // while the borderless Close pulls -mr-1.5 so its glyph lands on the gutter
    // (docs/ui-guidelines.md §3 optical alignment).
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-5 py-0">
      <AgentActivityAvatar
        agent={agent}
        display={display}
        size="sm"
        timeZone={timeZone}
        {...activity}
      />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold text-primary">{agent.displayName}</p>
        {/* What the Agent is doing, under its name — the line a direct message's header already
            shows, from the same `agentDisplay` the avatar's label reads, so the two cannot
            disagree. Nothing is shown when there is no live display: a deleted Agent has no
            status to report (ADR 0044) and "Status unknown" is not news. */}
        {display && (
          <p role="status" className="truncate text-xs text-tertiary">
            {statusLabel}
          </p>
        )}
        {agent.description && <p className="truncate text-xs text-tertiary">{agent.description}</p>}
      </div>
      <ButtonUtility
        icon={MessageSquare}
        size="sm"
        tooltip={m.agent_profile_panel_message()}
        href={localizeHref(`/messages/${agent.id}`)}
      />
      <ButtonUtility
        icon={controls.isOnline ? Stop : Play}
        size="sm"
        isDisabled={controls.startStopBusy}
        tooltip={controls.isOnline ? m.agent_control_stop() : m.agent_control_start()}
        onClick={controls.pressStartOrStop}
      />
      <ButtonUtility
        icon={RotateCcw}
        size="sm"
        tooltip={m.agent_control_restart_reset_tooltip()}
        onClick={() => controls.openRestart("restart")}
      />
      <ButtonUtility
        icon={X}
        size="sm"
        color="tertiary"
        className="-mr-1.5"
        tooltip={m.controls_close()}
        onClick={onClose}
      />
    </header>
  );
}
