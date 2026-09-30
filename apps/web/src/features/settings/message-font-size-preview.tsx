import { useHydrated } from "@tanstack/react-router";
import { useMemo } from "react";

import type { ChipMention } from "#src/features/conversations/message-markdown";
import { MessageRow, type MessageView } from "#src/features/conversations/message-row";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

const SAMPLE_CHANNEL_ID = "00000000-0000-4000-8000-000000000001";
const SAMPLE_CHANNEL_NAMES: ReadonlyMap<string, string> = new Map([
  [SAMPLE_CHANNEL_ID, "proj-uiux"],
]);
const SAMPLE_MENTIONS = new Map<string, ChipMention>([
  ["joy", { actorId: "sample-joy", handle: "joy", label: "Joy" }],
]);
const noop = () => {};

/**
 * One message as the stream draws it, sent by the viewer, so Settings → Message font size shows
 * the body, a mention, a channel chip and inline code at the chosen size. It is a picture, not a
 * message: inert, and drawn only after hydration because its time is the viewer's clock.
 */
export function MessageFontSizePreview({
  senderName,
  senderAvatarUrl,
}: {
  senderName: string;
  senderAvatarUrl: string | null;
}) {
  const hydrated = useHydrated();
  const message = useMemo<MessageView>(
    () => ({
      id: "message-font-size-preview",
      sequence: 0,
      senderKind: "user",
      senderName,
      senderAvatarUrl,
      body: `@joy <@channel:${SAMPLE_CHANNEL_ID}:proj-uiux> ${m.preferences_message_font_size_sample()}`,
      createdAt: new Date(),
      attachments: [],
    }),
    [senderName, senderAvatarUrl],
  );
  if (!hydrated) return null;
  return (
    <ul inert aria-label={m.preferences_message_font_size_preview()} className="-mx-4 md:-mx-6">
      <MessageRow
        message={message}
        own={false}
        dayChanged={false}
        grouped={false}
        expanded={false}
        onToggleExpanded={noop}
        collapsible={false}
        dateLocale={getLocale()}
        plainMentions={SAMPLE_MENTIONS}
        channelNames={SAMPLE_CHANNEL_NAMES}
      />
    </ul>
  );
}
