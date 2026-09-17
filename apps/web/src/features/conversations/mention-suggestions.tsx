import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import type { Mentionable } from "./mention-text";

/**
 * The @-completion popup above the composer textarea: a listbox of the channel's mentionable
 * members filtered to the in-progress query. Pointer selection happens on `pointerdown` so the
 * textarea never blurs mid-pick; keyboard interaction lives in `useMentionCompletion`.
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
  return (
    <div
      role="listbox"
      id={id}
      aria-label={m.conversation_mention_suggestions()}
      className="absolute bottom-full left-3 z-20 mb-1 w-72 overflow-hidden rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt"
    >
      <ul className="max-h-64 overflow-y-auto py-1">
        {items.map((item, index) => (
          <li
            key={`${item.kind}:${item.id}`}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            onPointerDown={(event) => {
              // Keep the textarea focused; the press itself picks the candidate.
              event.preventDefault();
              onChoose(item);
            }}
            onMouseEnter={() => onHighlight(index)}
            className={cx(
              "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
              index === activeIndex && "bg-secondary",
            )}
          >
            <span className="shrink-0 font-medium text-primary">@{item.handle}</span>
            {item.label !== item.handle && (
              <span className="truncate text-tertiary">{item.label}</span>
            )}
            <span className="ml-auto shrink-0 text-xs text-quaternary">
              {item.kind === "agent" ? m.member_agent() : m.member_person()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
