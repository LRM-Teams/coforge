import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  COLLAPSED_MESSAGE_MAX_HEIGHT_REM,
  overflowsCollapsedMessage,
} from "./collapsed-message-height";
import { MessageBody } from "./message-body";
import { messagePlainText } from "./selection-copy";

/**
 * A message body that collapses when it is very long, with a control to show the rest — Slack's
 * treatment for a wall of text.
 *
 * Only bodies that actually overflow get the control, and that is measured rather than inferred
 * from the text: the same 400 characters are three lines wide on a desktop and ten on a phone, and
 * Markdown makes any text-based rule worse — thirteen short headings are thirteen source lines but
 * far more than thirteen rendered ones, and a table or code block owns height its length does not
 * predict. So every body is measured; nothing is pre-filtered. A `line-clamp` cannot do this job
 * either (it needs an inline formatting context, and a Markdown body is a stack of block
 * elements), so the collapsed state is a `max-height` on a multiple of the line height, with a
 * mask fading the last line so the cut reads as "there is more" rather than as a clipped row.
 *
 * Clipped content is real content, so while collapsed the body is `inert`: a link or an Agent
 * mention below the cut cannot be tabbed into or clicked when nobody can see it. `inert` also
 * takes the body out of the accessibility tree, so the full message is offered to assistive
 * technology as text alongside it — a collapse is a device for saving screen space, not for
 * withholding the message, and a screen-reader user should not have to operate a visual control to
 * hear it. Expanding drops both, leaving the ordinary interactive body.
 *
 * `expanded` is owned by the conversation, not by this component: a row unmounts as soon as it
 * scrolls out of the virtualizer's window, and an expanded message must not silently re-collapse
 * behind the reader.
 */
export function CollapsibleMessageBody({
  body,
  mentions,
  expanded,
  collapsible = true,
  onToggleExpanded,
  ...bodyProps
}: ComponentProps<typeof MessageBody> & {
  expanded: boolean;
  /** Off (the viewer turned "Collapse long messages" off here): the body always shows in full,
   * and nothing is measured. */
  collapsible?: boolean;
  onToggleExpanded: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !collapsible) return;
    // Compare the body's full height with the collapsed height, never with its own client height:
    // `overflow-hidden` is applied only once we know it overflows, so measuring the clamp would
    // never see an overflow in the first place. `scrollHeight` is the full content height in both
    // states, which also keeps the control visible while expanded — the reader needs the way back.
    // The collapsed height is rem, so it is resolved against the root font size at measure time.
    const measure = () =>
      setOverflowing(
        overflowsCollapsedMessage(
          content.scrollHeight,
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        ),
      );
    measure();
    // The clamped height depends on the width, which changes with the window, the sidebar and the
    // thread panel, and on the text size, which also resizes the body. The control renders *below* the clamped box, so this cannot feed back into its
    // own measurement.
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [body, collapsible]);

  // Off, nothing folds and no control shows, whatever the last measurement said.
  const foldable = collapsible && overflowing;
  const collapsed = foldable && !expanded;
  const { channelNames } = bodyProps;
  const plainText = useMemo(
    () => (collapsed ? messagePlainText({ body, mentions }, channelNames) : ""),
    [collapsed, body, mentions, channelNames],
  );

  return (
    <>
      {collapsed && <p className="sr-only">{plainText}</p>}
      <div
        ref={contentRef}
        aria-hidden={collapsed || undefined}
        inert={collapsed}
        // `overflow-hidden` only while collapsed: a code block or table inside the body keeps its
        // own horizontal scrolling when the body is open.
        className={cn(
          collapsed &&
            "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
        )}
        style={collapsed ? { maxHeight: `${COLLAPSED_MESSAGE_MAX_HEIGHT_REM}rem` } : undefined}
      >
        <MessageBody body={body} mentions={mentions} {...bodyProps} />
      </div>
      {foldable && (
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
