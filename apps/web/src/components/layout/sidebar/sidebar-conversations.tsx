import { Plus } from "@untitledui/icons";

import { NavItemBase } from "@/components/application/app-navigation/base-components/nav-item";
import { Avatar } from "@/components/base/avatar/avatar";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import type { ConversationAgent } from "@/features/conversations/conversation-layout";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import { localizeHref } from "@/paraglide/runtime";

export type SidebarChannel = { id: string; name: string; joined: boolean };

/**
 * The Slack-model sidebar sections under the four top-level nav items:
 * Channels (public, workspace-wide) and Direct messages (one per Agent).
 * Shared by the expanded desktop sidebar and the mobile drawer so both stay
 * in sync — see docs/ui-guidelines.md §3/§9 for the section-header and
 * status-dot conventions this follows.
 */
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
      <div className="mt-4">
        <div className="flex h-8 items-center justify-between px-4">
          <span className="text-xs font-semibold text-quaternary">{m.channels_title()}</span>
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
          {sortedChannels.map((channel) => (
            <li key={channel.id} className="py-px">
              <NavItemBase
                type="link"
                href={localizeHref(`/messages/channels/${channel.id}`)}
                current={channel.id === selectedChannelId}
              >
                <span className={cx("truncate", !channel.joined && "text-tertiary")}>
                  #{channel.name}
                </span>
              </NavItemBase>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4">
        <div className="flex h-8 items-center px-4">
          <span className="text-xs font-semibold text-quaternary">
            {m.messages_agents_action()}
          </span>
        </div>
        <ul aria-label={m.messages_agents_action()} className="flex flex-col px-4 pb-3">
          {agents.map((agent) => (
            <li key={agent.id} className="py-px">
              <NavItemBase
                type="link"
                href={localizeHref(`/messages/${agent.id}`)}
                current={agent.id === selectedAgentId}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar
                    size="xs"
                    alt={agent.displayName}
                    initials={avatarInitial(agent.displayName)}
                    contentClassName={avatarToneClassName(agent.displayName)}
                    status={agent.status.value === "active" ? "online" : "offline"}
                  />
                  <span className="truncate">{agent.displayName}</span>
                </span>
              </NavItemBase>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
