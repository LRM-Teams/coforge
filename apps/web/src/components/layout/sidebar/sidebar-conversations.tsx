import { Hash01 as Hash, Plus } from "@untitledui/icons";
import type { ReactNode } from "react";

import { Avatar } from "@/components/base/avatar/avatar";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import type { ConversationAgent } from "@/features/conversations/conversation-layout";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import { localizeHref } from "@/paraglide/runtime";

export type SidebarChannel = { id: string; name: string; joined: boolean };

// A local row (not NavItemBase — its `icon` slot hardcodes size-5 and can't
// take an Avatar) so channel and DM rows share one grid: 20px icon column,
// text starting at the same x, and the same current/hover treatment.
function SidebarRow({
  href,
  current,
  icon,
  muted,
  children,
}: {
  href: string;
  current?: boolean;
  icon: ReactNode;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
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
          current ? "font-semibold text-brand-secondary" : muted ? "text-tertiary" : "text-secondary",
        )}
      >
        {children}
      </span>
    </a>
  );
}

/** Channels + Direct-messages sections, shared by the channel sidebar and
 * the mobile drawer so both stay in sync. */
export function SidebarConversations({
  channels,
  agents,
  selectedChannelId,
  selectedAgentId,
  onCreateChannel,
}: {
  channels: SidebarChannel[];
  agents: ConversationAgent[];
  selectedChannelId?: string;
  selectedAgentId?: string;
  onCreateChannel?: () => void;
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
          {onCreateChannel && (
            <ButtonUtility
              icon={Plus}
              size="xs"
              color="tertiary"
              tooltip={m.channel_create()}
              onClick={onCreateChannel}
            />
          )}
        </div>
        <ul aria-label={m.channels_title()} className="flex flex-col px-4">
          {sortedChannels.map((channel) => {
            const current = channel.id === selectedChannelId;
            return (
              <li key={channel.id} className="py-px">
                <SidebarRow
                  href={localizeHref(`/messages/channels/${channel.id}`)}
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
                </SidebarRow>
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
              <SidebarRow
                href={localizeHref(`/messages/${agent.id}`)}
                current={agent.id === selectedAgentId}
                icon={
                  <Avatar
                    size="xs"
                    alt={agent.displayName}
                    initials={avatarInitial(agent.displayName)}
                    contentClassName={avatarToneClassName(agent.displayName)}
                    status={agent.status.value === "active" ? "online" : "offline"}
                  />
                }
              >
                {agent.displayName}
              </SidebarRow>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
