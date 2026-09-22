import { useEffect, useMemo, useRef } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { AgentDisplayAvatar } from "@/features/agents/agent-activity-avatar";
import { useLiveAgents } from "@/features/agents/workspace-agents-realtime";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import type { Mentionable } from "./mention-text";

/**
 * The @-completion popup above the composer textarea: a listbox of the channel's mentionable
 * members filtered to the in-progress query. Each row shows the member's avatar, display name,
 * handle and (for people who have one) profile description, plus an "Agent" badge for Agents.
 * An Agent's avatar carries the same online/working/thinking/error/offline dot the sidebar and
 * conversation header use, so you can see whether an Agent is around before mentioning it; the
 * snapshot comes from the app shell's one subscription through `useLiveAgents`. People have no
 * presence in the product, so a person's avatar stays plain.
 * Pointer selection keeps the textarea focused on `pointerdown`, then commits on `click`. Delaying
 * the commit until click keeps the option mounted through the browser's touch click synthesis;
 * otherwise unmounting it on pointerdown can retarget the synthesized click to the message row
 * beneath the popup on mobile. Keyboard interaction lives in `useMentionCompletion`.
 */
export function MentionSuggestionList({
  id,
  items,
  activeIndex,
  optionId,
  onChoose,
  onHighlight,
}: {
  id: string;
  items: readonly Mentionable[];
  activeIndex: number;
  optionId: (index: number) => string;
  onChoose: (item: Mentionable) => void;
  onHighlight: (index: number) => void;
}) {
  const activeOptionRef = useRef<HTMLLIElement>(null);
  const liveAgents = useLiveAgents();
  const displayByAgentId = useMemo(
    () => new Map(liveAgents.map((agent) => [agent.id, agent.display])),
    [liveAgents],
  );

  // Keep the highlighted row visible while arrowing past the popup's own scroll window.
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      role="listbox"
      id={id}
      aria-label={m.conversation_mention_suggestions()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className="absolute bottom-full left-3 z-20 mb-1 w-80 max-w-[calc(100%-1.5rem)] origin-bottom overflow-hidden rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out motion-reduce:animate-none"
    >
      <ul className="max-h-[min(16rem,40svh)] overscroll-contain overflow-y-auto py-1 [touch-action:pan-y]">
        {items.map((item, index) => {
          const active = index === activeIndex;
          return (
            <li
              key={`${item.kind}:${item.id}`}
              ref={active ? activeOptionRef : undefined}
              id={optionId(index)}
              role="option"
              aria-selected={active}
              onPointerDown={(event) => {
                // Keep the textarea focused. Commit on click so a mobile browser cannot synthesize
                // its click against the message row after this option unmounts.
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChoose(item);
              }}
              onMouseEnter={() => onHighlight(index)}
              className={cx(
                "flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 py-2",
                active && "bg-secondary",
              )}
            >
              {item.kind === "agent" ? (
                <AgentDisplayAvatar
                  name={item.label}
                  src={item.avatarUrl}
                  display={displayByAgentId.get(item.id)}
                  size="sm"
                />
              ) : (
                <Avatar
                  size="sm"
                  alt=""
                  src={item.avatarUrl}
                  initials={avatarInitial(item.label)}
                  contentClassName={avatarToneClassName(item.label)}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-1.5 text-sm">
                  <span className="min-w-0 truncate font-medium text-primary">{item.label}</span>
                  {item.label !== item.handle && (
                    <span className="shrink-0 text-tertiary">@{item.handle}</span>
                  )}
                </p>
                {item.description && (
                  <p className="truncate text-xs text-tertiary">{item.description}</p>
                )}
              </div>
              {item.kind === "agent" && (
                <Badge size="sm" color="gray" type="modern" className="ml-auto shrink-0">
                  {m.member_agent()}
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
