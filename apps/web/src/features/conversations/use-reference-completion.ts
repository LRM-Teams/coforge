import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { filterMentionables, type Mentionable } from "./mention-text";
import {
  activeReferenceQuery,
  filterChannelSuggestions,
  insertReference,
  type ChannelSuggestion,
  type ReferenceTrigger,
} from "./reference-completion";

/** One row of the composer's completion list: a member for `@`, a channel for `#`. */
export type ReferenceSuggestion =
  | { kind: "mention"; mention: Mentionable }
  | { kind: "channel"; channel: ChannelSuggestion };

/**
 * The `@` list: members first, then the people and Agents outside the channel, each ranked on its
 * own. While the two lists refetch after a membership change, someone can briefly be in both;
 * they are offered once, as a member.
 */
function mentionCandidates(
  mentionables: readonly Mentionable[] | undefined,
  outsiders: readonly Mentionable[] | undefined,
  query: string,
  recentHandles: readonly string[] | undefined,
): Mentionable[] {
  const members = filterMentionables(mentionables ?? [], query, { recentHandles });
  const memberKeys = new Set((mentionables ?? []).map((item) => `${item.kind}:${item.id}`));
  return [
    ...members,
    ...filterMentionables(
      (outsiders ?? []).filter((item) => !memberKeys.has(`${item.kind}:${item.id}`)),
      query,
      { recentHandles },
    ),
  ];
}

/** The text a chosen suggestion puts in the draft (before its trailing space). */
function referenceText(item: ReferenceSuggestion): string {
  return item.kind === "mention" ? `@${item.mention.handle}` : `#${item.channel.name}`;
}

/**
 * The composer's reference completion, self-contained: tracks the in-progress `@query` or
 * `#query` token at the caret, owns the popup's open/highlight state and its keyboard
 * interaction (ArrowUp/Down cycle, Enter/Tab choose, Escape dismiss), and applies a chosen
 * member or channel by splicing `@handle ` or `#name ` into the text through the caller's
 * `onChange`. IME compositions are left untouched. `textareaRef` must be attached to the
 * composer textarea; the hook restores the caret after an insertion.
 */
export function useReferenceCompletion({
  mentionables,
  mentionOutsiders,
  recentHandles,
  channels,
  currentChannelId,
  value,
  onChange,
}: {
  /** The conversation's @-completion candidates; empty/undefined keeps the `@` popup closed. */
  mentionables: readonly Mentionable[] | undefined;
  /** Candidates outside the channel, ranked on their own and listed after the members. */
  mentionOutsiders?: readonly Mentionable[];
  /** Handles that recently sent a message in this conversation, most-recent first; ranks
   * completion candidates ahead of alphabetical order within a match tier. */
  recentHandles?: readonly string[];
  /** The Workspace's channels for `#`-completion; empty/undefined keeps the `#` popup closed. */
  channels?: readonly ChannelSuggestion[];
  /** This conversation's id: when it is a channel, that channel leads the `#` list. */
  currentChannelId?: string;
  /** The composer text (controlled). */
  value: string;
  /** Replaces the composer text after a candidate insertion. */
  onChange: (value: string) => void;
}): {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  open: boolean;
  /** The trigger of the open list, which names it for assistive tech. */
  trigger: ReferenceTrigger | undefined;
  items: ReferenceSuggestion[];
  activeIndex: number;
  listboxId: string;
  optionId: (index: number) => string;
  /** Wire into the textarea's change/select: tracks the query as text or caret move. */
  track: (text: string, caret: number | null) => void;
  /** Wire into the textarea's keydown; true when the popup consumed the key. `composing`
   * lets the caller extend IME detection beyond `nativeEvent.isComposing`. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, composing?: boolean) => boolean;
  choose: (item: ReferenceSuggestion) => void;
  close: () => void;
  setActiveIndex: (index: number) => void;
} {
  const baseId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<ReturnType<typeof activeReferenceQuery>>();
  const [highlighted, setHighlighted] = useState(0);
  // A caret position to restore once React has committed the reference insertion.
  const pendingCaretRef = useRef<number | undefined>(undefined);

  const items: ReferenceSuggestion[] = !query
    ? []
    : query.trigger === "@"
      ? mentionCandidates(mentionables, mentionOutsiders, query.query, recentHandles).map(
          (mention) => ({
            kind: "mention",
            mention,
          }),
        )
      : filterChannelSuggestions(channels ?? [], query.query, { currentChannelId }).map(
          (channel) => ({ kind: "channel", channel }),
        );
  const open = items.length > 0;
  const activeIndex = Math.min(highlighted, items.length - 1);

  useEffect(() => {
    if (pendingCaretRef.current === undefined) return;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = undefined;
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  }, [value]);

  function track(text: string, caret: number | null) {
    setQuery(caret === null ? undefined : activeReferenceQuery(text, caret));
    setHighlighted(0);
  }

  function choose(item: ReferenceSuggestion) {
    const textarea = textareaRef.current;
    if (!query || !textarea) return;
    const caret = textarea.selectionStart ?? query.start + query.query.length + 1;
    const next = insertReference(value, query.start, caret, referenceText(item));
    pendingCaretRef.current = next.caret;
    onChange(next.value);
    setQuery(undefined);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, composing?: boolean) {
    if (!open) return false;
    const ime = event.nativeEvent.isComposing || composing;
    if (!ime && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + delta + items.length) % items.length);
      return true;
    }
    if (!ime && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      choose(items[activeIndex]!);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery(undefined);
      return true;
    }
    return false;
  }

  return {
    textareaRef,
    open,
    trigger: open ? query?.trigger : undefined,
    items,
    activeIndex,
    listboxId: `${baseId}-references`,
    optionId: (index) => `${baseId}-reference-${index}`,
    track,
    handleKeyDown,
    choose,
    close: () => setQuery(undefined),
    setActiveIndex: setHighlighted,
  };
}
