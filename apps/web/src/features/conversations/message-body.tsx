import { Fragment } from "react";
import { splitMentionSegments, type MentionRef } from "./mention-text";
import { cx } from "@/utils/cx";

/**
 * A message body with mentions highlighted as inline chips. Stored `<@kind:uuid>` tokens render
 * through the message's mention rows; anything else — including pre-token plain `@handle` text
 * and DMs, which carry no tokens — renders as written (token-only by design, no legacy
 * compatibility). A mention of the viewing user gets the stronger treatment, the way Slack
 * marks "@you". Chips are non-interactive: membership and wake rules live on the server, and a
 * mention is a reference, not a link.
 */
export function MessageBody({
  body,
  mentions = [],
  viewerHandle,
}: {
  body: string;
  mentions?: readonly MentionRef[];
  viewerHandle?: string;
}) {
  const segments = splitMentionSegments(body, mentions);
  return segments.map((segment, index) =>
    segment.kind === "mention" ? (
      <span
        key={index}
        className={cx(
          "rounded-sm px-0.5 font-medium",
          viewerHandle && segment.handle === viewerHandle
            ? "bg-brand-solid text-white"
            : "bg-brand-primary text-brand-secondary",
        )}
      >
        {segment.text}
      </span>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}
