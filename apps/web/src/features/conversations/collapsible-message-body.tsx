import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { MessageBody } from "./message-body";

/** Collapsed height, in px: 13 lines of the body's 24px line-height. Long enough that an ordinary
 * message is never touched, short enough that one wall of text cannot take over the viewport. */
const COLLAPSED_MAX_HEIGHT = 13 * 24;

/**
 * Whether a body is even worth measuring. Both halves matter: a dense CJK paragraph gets long
 * before it gets many lines, and a 20-item list is many lines while staying short.
 */
function mightOverflow(body: string): boolean {
  return body.length > 200 || body.split("\n").length > 13;
}

/**
 * A message body that collapses when it is very long, with a control to show the rest — Slack's
 * treatment for a wall of text.
 *
 * Only bodies that actually overflow get the control, and that is measured rather than guessed
 * from the text: the same 400 characters are three lines wide on a desktop and ten on a phone,
 * and Markdown makes any character-count rule worse (a table or a code block owns far more
 * height than its length suggests). A `line-clamp` cannot do this job either — it needs an
 * inline formatting context, and a Markdown body is a stack of block elements — so the collapsed
 * state is a `max-height` on a multiple of the line height, with a mask fading the last line so
 * the cut reads as "there is more" rather than as a clipped row.
 *
 * `expanded` is owned by the conversation, not by this component: a row unmounts as soon as it
 * scrolls out of the virtualizer's window, and an expanded message must not silently re-collapse
 * behind the reader.
 */
export function CollapsibleMessageBody({
  body,
  expanded,
  onToggleExpanded,
  ...bodyProps
}: ComponentProps<typeof MessageBody> & {
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const measurable = mightOverflow(body);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !measurable) {
      setOverflowing(false);
      return;
    }
    // Compare the body's full height to the collapsed height, not to its own client height:
    // `overflow-hidden` is only applied once we know it overflows, so measuring the clamp would
    // never see an overflow in the first place. `scrollHeight` is the full content height in both
    // states, which also keeps the control visible while expanded (the reader needs the way back).
    const measure = () => setOverflowing(content.scrollHeight > COLLAPSED_MAX_HEIGHT + 1);
    measure();
    // The clamped height depends on the width, which changes with the window, the sidebar and
    // the thread panel. Showing the control adds height *below* the clamped box, so this cannot
    // feed back into its own measurement.
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [body, measurable]);

  const collapsed = overflowing && !expanded;

  return (
    <>
      <div
        ref={contentRef}
        // `overflow-hidden` only while collapsed: a code block or table inside the body keeps its
        // own horizontal scrolling when the body is open.
        className={cn(
          collapsed &&
            "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
        )}
        style={collapsed ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
      >
        <MessageBody body={body} {...bodyProps} />
      </div>
      {overflowing && (
        <Button
          color="link-gray"
          size="sm"
          className="mt-0.5 w-fit font-semibold"
          aria-expanded={expanded}
          onPress={onToggleExpanded}
          iconTrailing={
            <ChevronDown
              aria-hidden="true"
              className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
            />
          }
        >
          {expanded ? m.conversation_message_show_less() : m.conversation_message_show_more()}
        </Button>
      )}
    </>
  );
}
