import { FaceSmile } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

/**
 * One-tap emojis for message reactions. Kept to single emojis without whitespace so
 * every entry satisfies the server's `isValidReactionEmoji` (shared with the Agent
 * reaction API); a full picker would need a new dependency for little gain here.
 * Exported for the mobile message-actions menu, which offers the same set inline.
 */
export const QUICK_REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "🔥", "😂", "😮", "😢"] as const;

/**
 * The smiley button in a message's hover toolbar. Opens a small popover with the
 * quick emojis; picking one calls `onPick` and closes the popover.
 */
export function MessageReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const label = m.conversation_add_reaction();
  return (
    <DialogTrigger>
      <ButtonUtility
        icon={FaceSmile}
        size="xs"
        color="tertiary"
        tooltip={label}
        aria-label={label}
        className="p-1 *:data-icon:size-3.5"
      />
      <AriaPopover
        placement="top start"
        offset={8}
        // Portaled out of the message row's DOM; the row's tap-to-toggle-actions gesture
        // treats interaction inside this popover as still on its own toolbar.
        data-message-actions-popover
        className="rounded-xl bg-primary p-1.5 shadow-lg ring-1 ring-secondary_alt outline-none"
      >
        <Dialog className="outline-none">
          {({ close }) => (
            <div role="group" aria-label={label} className="flex items-center gap-0.5">
              {QUICK_REACTION_EMOJIS.map((emoji) => (
                <Button
                  key={emoji}
                  color="tertiary"
                  size="sm"
                  noTextPadding
                  onPress={() => {
                    onPick(emoji);
                    close();
                  }}
                  className="h-auto rounded-md p-1 text-xl leading-none"
                >
                  {emoji}
                </Button>
              ))}
            </div>
          )}
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
  );
}
