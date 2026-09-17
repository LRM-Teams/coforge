import { useEffect, useRef } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import type { Mentionable } from "./mention-text";

/**
 * The @-completion popup above the composer textarea: a listbox of the channel's mentionable
 * members filtered to the in-progress query. Each row shows the member's avatar, display name,
 * handle and (for people who have one) profile description, plus an "Agent" badge for Agents.
 * Pointer selection happens on `pointerdown` so the textarea never blurs mid-pick; keyboard
 * interaction lives in `useMentionCompletion`.
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

  // Keep the highlighted row visible while arrowing past the popup's own scroll window.
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      role="listbox"
      id={id}
      aria-label={m.conversation_mention_suggestions()}
      className="absolute bottom-full left-3 z-20 mb-1 w-80 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt"
    >
      <ul className="max-h-64 overflow-y-auto py-1">
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
                // Keep the textarea focused; the press itself picks the candidate.
                event.preventDefault();
                onChoose(item);
              }}
              onMouseEnter={() => onHighlight(index)}
              className={cx(
                "flex cursor-pointer items-center gap-2 px-3 py-1.5",
                active && "bg-secondary",
              )}
            >
              <Avatar
                size="sm"
                alt=""
                src={item.avatarUrl}
                initials={avatarInitial(item.label)}
                contentClassName={avatarToneClassName(item.label)}
              />
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
