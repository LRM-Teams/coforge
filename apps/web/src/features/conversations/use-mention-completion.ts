import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  activeMentionQuery,
  filterMentionables,
  insertMention,
  type Mentionable,
} from "./mention-text";

/**
 * The composer's @-completion behavior, self-contained: tracks the in-progress `@query` token
 * at the caret, owns the popup's open/highlight state and its keyboard interaction
 * (ArrowUp/Down cycle, Enter/Tab choose, Escape dismiss), and applies a chosen candidate by
 * splicing `@handle ` into the text through the caller's `onChange`. IME compositions are left
 * untouched. `textareaRef` must be attached to the composer textarea; the hook restores the
 * caret after an insertion.
 */
export function useMentionCompletion({
  mentionables,
  value,
  onChange,
}: {
  /** The channel's completion candidates; empty/undefined keeps the popup closed. */
  mentionables: readonly Mentionable[] | undefined;
  /** The composer text (controlled). */
  value: string;
  /** Replaces the composer text after a candidate insertion. */
  onChange: (value: string) => void;
}): {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  open: boolean;
  items: Mentionable[];
  activeIndex: number;
  listboxId: string;
  optionId: (index: number) => string;
  /** Wire into the textarea's change/select: tracks the query as text or caret move. */
  track: (text: string, caret: number | null) => void;
  /** Wire into the textarea's keydown; true when the popup consumed the key. `composing`
   * lets the caller extend IME detection beyond `nativeEvent.isComposing`. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, composing?: boolean) => boolean;
  choose: (item: Mentionable) => void;
  close: () => void;
  setActiveIndex: (index: number) => void;
} {
  const baseId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ start: number; query: string }>();
  const [highlighted, setHighlighted] = useState(0);
  // A caret position to restore once React has committed the mention insertion.
  const pendingCaretRef = useRef<number | undefined>(undefined);

  const items = query && mentionables?.length ? filterMentionables(mentionables, query.query) : [];
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
    if (!mentionables?.length || caret === null) {
      setQuery(undefined);
      return;
    }
    setQuery(activeMentionQuery(text, caret));
    setHighlighted(0);
  }

  function choose(item: Mentionable) {
    const textarea = textareaRef.current;
    if (!query || !textarea) return;
    const caret = textarea.selectionStart ?? query.start + query.query.length + 1;
    const next = insertMention(value, query.start, caret, item.handle);
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
    items,
    activeIndex,
    listboxId: `${baseId}-mentions`,
    optionId: (index) => `${baseId}-mention-${index}`,
    track,
    handleKeyDown,
    choose,
    close: () => setQuery(undefined),
    setActiveIndex: setHighlighted,
  };
}
