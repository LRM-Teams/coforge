import { Hash01 as Hash } from "@untitledui/icons";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { AgentDisplayAvatar } from "@/features/agents/agent-activity-avatar";
import type { LiveAgent } from "@/features/agents/workspace-agents-realtime";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";

type DirectoryChannel = { id: string; name: string; joined: boolean };

// A local row (not NavItemBase — its `icon` slot hardcodes size-5 and can't
// take an Avatar) so channel and DM rows share one grid: 20px icon column,
// text starting at the same x, and the same current/hover treatment.
function ConversationRow({
  target,
  current,
  icon,
  muted,
  children,
}: {
  target: { channelId: string } | { agentId: string };
  current?: boolean;
  icon: ReactNode;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      {...("channelId" in target
        ? { to: "/messages/channels/$channelId", params: target }
        : { to: "/messages/$agentId", params: target })}
      aria-current={current ? "page" : undefined}
      className={cx(
        "flex max-h-9 w-full cursor-pointer items-center gap-2 rounded-md p-2 outline-focus-ring transition duration-100 ease-linear select-none focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2",
        current ? "bg-sidebar-accent" : "hover:bg-primary_hover",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span
        className={cx(
          "flex-1 truncate text-sm",
          current
            ? "font-semibold text-brand-secondary"
            : muted
              ? "text-tertiary"
              : "text-secondary",
        )}
      >
        {children}
      </span>
    </Link>
  );
}

/** Channel and direct-message selection within the Chat page. */
export function ConversationDirectory({
  channels,
  agents,
  selectedChannelId,
  selectedAgentId,
}: {
  channels: DirectoryChannel[];
  agents: LiveAgent[];
  selectedChannelId?: string;
  selectedAgentId?: string;
}) {
  const sortedChannels = [...channels].sort((left, right) =>
    left.joined === right.joined ? 0 : left.joined ? -1 : 1,
  );
  return (
    <>
      <div className="mt-2">
        <div className="flex h-7 items-center justify-between pr-4 pl-6">
          <span className="text-[11px] font-semibold tracking-wide text-quaternary uppercase">
            {m.channels_title()}
          </span>
        </div>
        <ul aria-label={m.channels_title()} className="flex flex-col px-4">
          {sortedChannels.map((channel) => {
            const current = channel.id === selectedChannelId;
            return (
              <li key={channel.id} className="py-px">
                <ConversationRow
                  target={{ channelId: channel.id }}
                  current={current}
                  muted={!channel.joined}
                  icon={
                    <Hash
                      aria-hidden="true"
                      className={cx("size-4", current ? "text-brand-secondary" : "text-tertiary")}
                    />
                  }
                >
                  {channel.name}
                </ConversationRow>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-4">
        <div className="flex h-7 items-center pl-6">
          <span className="text-[11px] font-semibold tracking-wide text-quaternary uppercase">
            {m.messages_agents_action()}
          </span>
        </div>
        <ul aria-label={m.messages_agents_action()} className="flex flex-col px-4 pb-3">
          {agents.map((agent) => (
            <li key={agent.id} className="py-px">
              <ConversationRow
                target={{ agentId: agent.id }}
                current={agent.id === selectedAgentId}
                icon={
                  <AgentDisplayAvatar name={agent.displayName} display={agent.display} size="xs" />
                }
              >
                {agent.displayName}
              </ConversationRow>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
