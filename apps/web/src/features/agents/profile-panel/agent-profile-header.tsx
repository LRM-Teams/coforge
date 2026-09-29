import {
  ArrowLeft,
  MessageSquare01 as MessageSquare,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
  XClose as X,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { m } from "#src/paraglide/messages";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";

/**
 * The panel's first band (48px, the same height as Thread's header): the Agent's identity on the
 * left, bordered icon buttons on the right — Message, Start-or-Stop, Restart/Reset, then a plain
 * Close. Available on every tab (rendered once by the panel shell, not per tab). All four use the
 * official `ButtonUtility` with its `tooltip` prop.
 */
export function AgentProfileHeader({
  agent,
  display,
  controls,
  canMessage,
  onClose,
  back,
}: {
  agent: {
    id: string;
    displayName: string;
    avatarUrl?: string | null;
  };
  display?: AgentDisplaySnapshot;
  controls: AgentRuntimeControls;
  /** The viewer created this Agent: only its creator has a direct message with it. */
  canMessage: boolean;
  onClose: () => void;
  /** Where the profile was opened from, when it is shown inside another page (a channel's
   * members): a Back button before the avatar returns there. */
  back?: { label: string; onPress: () => void };
}) {
  const openDirectConversation = useOpenDirectConversation();
  return (
    // Same 20px gutter as the panel body (px-5): the bordered utility buttons align by box edge,
    // while the borderless Close pulls -mr-1.5 so its glyph lands on the gutter
    // (docs/design/page-skeleton-and-density.md §8 optical alignment).
    <header className="flex h-12 shrink-0 items-center gap-2 px-5 py-0">
      {back && (
        <ButtonUtility
          icon={ArrowLeft}
          size="sm"
          color="tertiary"
          className="-ml-1.5"
          tooltip={back.label}
          aria-label={back.label}
          onClick={back.onPress}
        />
      )}
      <AgentDisplayAvatar name={agent.displayName} src={agent.avatarUrl} display={display} />
      {/* The name alone: the avatar's dot carries the live status
          and the Profile tab the description. */}
      <p className="min-w-0 flex-1 truncate text-[1.0625rem] leading-tight font-medium tracking-tight text-secondary">
        {agent.displayName}
      </p>
      {canMessage && (
        <ButtonUtility
          icon={MessageSquare}
          size="sm"
          tooltip={m.agent_profile_panel_message()}
          onClick={() => void openDirectConversation({ agentId: agent.id })}
        />
      )}
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
