import { useEffect, useMemo, useRef } from "react";
import { Hash01 as Hash } from "@untitledui/icons";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Badge } from "#src/components/base/badges/badges";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import { useLiveAgents } from "#src/features/agents/workspace-agents-realtime";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import type { Mentionable } from "./mention-text";
import type { ChannelSuggestion, ReferenceTrigger } from "./reference-completion";
import type { ReferenceSuggestion } from "./use-reference-completion";

/**
 * The reference-completion popup above the composer textarea: a listbox of the conversation's
 * mentionable members (`@`) or the Workspace's channels (`#`), filtered to the in-progress query.
 * Every row is one line so more candidates fit above the composer. A member row reads avatar,
 * display name, a Human/Agent badge and the profile description, with the `@handle` pinned to the
 * right edge. A channel row reads a `#` icon, the name and the description, with an "Archived"
 * badge on the right; an archived channel's row is dimmed.
 * An Agent's avatar carries the same online/working/thinking/error/offline dot the sidebar and
 * conversation header use, so you can see whether an Agent is around before mentioning it; the
 * snapshot comes from the app shell's one subscription through `useLiveAgents`. People have no
 * presence in the product, so a person's avatar stays plain.
 * Pointer selection keeps the textarea focused with `pointerdown` (prevented) and commits on
 * `pointerup`. Committing on pointerup — rather than pointerdown or the synthesized click —
 * is what makes taps work everywhere: canceling pointerdown suppresses the compatibility
 * mouse events touch input relies on, so on mobile Safari no click ever arrives; and
 * committing on pointerdown unmounts the option early enough that the synthesized click can
 * retarget to the message row beneath the popup. `pointerup` fires for mouse, touch and pen
 * while the option is still mounted. The `click` handler stays as a fallback (assistive tech
 * may activate without pointer events); `choose` early-returns once the query is gone, so a
 * second activation is a no-op. Keyboard interaction lives in `useReferenceCompletion`.
 */
export function ReferenceSuggestionList({
  id,
  trigger,
  items,
  activeIndex,
  optionId,
  onChoose,
  onHighlight,
}: {
  id: string;
  trigger: ReferenceTrigger;
  items: readonly ReferenceSuggestion[];
  activeIndex: number;
  optionId: (index: number) => string;
  onChoose: (item: ReferenceSuggestion) => void;
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
      aria-label={
        trigger === "#"
          ? m.conversation_channel_suggestions()
          : m.conversation_mention_suggestions()
      }
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className="absolute inset-x-3 bottom-full z-20 mb-1 origin-bottom overflow-hidden rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out motion-reduce:animate-none"
    >
      <ul
        role="presentation"
        className="max-h-[min(16rem,40svh)] overscroll-contain overflow-y-auto py-1 [touch-action:pan-y]"
      >
        {items.map((item, index) => {
          const active = index === activeIndex;
          return (
            <li
              key={
                item.kind === "mention"
                  ? `${item.mention.kind}:${item.mention.id}`
                  : `channel:${item.channel.id}`
              }
              ref={active ? activeOptionRef : undefined}
              id={optionId(index)}
              role="option"
              aria-selected={active}
              onPointerDown={(event) => {
                // Keep the textarea focused; the choice itself commits on pointerup below.
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerUp={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChoose(item);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChoose(item);
              }}
              onMouseEnter={() => onHighlight(index)}
              className={cx(
                "flex min-h-9 cursor-pointer select-none items-center gap-2 px-3 py-1.5 pointer-coarse:min-h-11",
                active && "bg-secondary",
              )}
            >
              {item.kind === "mention" ? (
                <MentionRow
                  mention={item.mention}
                  display={displayByAgentId.get(item.mention.id)}
                />
              ) : (
                <ChannelRow channel={item.channel} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A member row: avatar (an Agent's with its live status dot), name, kind, description, handle. */
function MentionRow({
  mention,
  display,
}: {
  mention: Mentionable;
  display: AgentDisplaySnapshot | undefined;
}) {
  return (
    <>
      {mention.kind === "agent" ? (
        <AgentDisplayAvatar
          name={mention.label}
          src={mention.avatarUrl}
          display={display}
          size="xs"
        />
      ) : (
        <Avatar
          size="xs"
          alt=""
          src={mention.avatarUrl}
          initials={avatarInitial(mention.label)}
          contentClassName={avatarToneClassName(mention.label)}
        />
      )}
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] items-center gap-1.5">
        <span className="truncate text-sm font-medium text-primary">{mention.label}</span>
        <Badge size="sm" color="gray" type="modern">
          {mention.kind === "agent" ? m.member_agent() : m.member_person()}
        </Badge>
        {mention.description && (
          <span className="truncate text-xs text-tertiary">{mention.description}</span>
        )}
      </span>
      <span className="ml-auto max-w-[40%] min-w-0 truncate text-xs text-quaternary">
        @{mention.handle}
      </span>
    </>
  );
}

/** A channel row: `#` icon, name, description, and an "Archived" badge on an archived channel. */
function ChannelRow({ channel }: { channel: ChannelSuggestion }) {
  return (
    <>
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center">
        <Hash className={cx("size-4", channel.archived ? "text-quaternary" : "text-tertiary")} />
      </span>
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-center gap-2">
        <span
          className={cx(
            "truncate text-sm font-medium",
            channel.archived ? "text-tertiary" : "text-primary",
          )}
        >
          {channel.name}
        </span>
        {channel.description && (
          <span
            className={cx(
              "truncate text-xs",
              channel.archived ? "text-quaternary" : "text-tertiary",
            )}
          >
            {channel.description}
          </span>
        )}
      </span>
      {channel.archived && (
        <Badge size="sm" color="gray" type="modern" className="ml-auto shrink-0">
          {m.conversation_channel_archived()}
        </Badge>
      )}
    </>
  );
}
