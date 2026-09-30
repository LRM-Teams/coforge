import { AlertCircle, XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { mentionKey, mentionKeysShowingHandle, type Mentionable } from "./mention-text";

/**
 * Above the textarea, when the draft holds a name typed by hand that matches a member (`@张三`) but
 * was never picked from the `@` list, so sending it would notify no one: asks who was meant and
 * offers each member who reads that way. Choosing one pins them to the name (`mention-pins.ts`),
 * which sending turns into a real mention; dismissing keeps the text as it is. A candidate reads by
 * its name alone unless several share it, when the description (and, for two who read identically,
 * the `@handle`) tells them apart.
 */
export function UnpinnedMentionHint({
  label,
  candidates,
  onPick,
  onDismiss,
}: {
  label: string;
  candidates: readonly Mentionable[];
  onPick: (mention: Mentionable) => void;
  onDismiss: () => void;
}) {
  const name = `@${label}`;
  const several = candidates.length > 1;
  const showHandle = several ? mentionKeysShowingHandle(candidates) : undefined;
  return (
    <div role="status" className="flex items-start gap-2 px-2 text-sm text-tertiary">
      <AlertCircle aria-hidden="true" className="mt-1 size-4 shrink-0 text-fg-warning-primary" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <p className="min-w-0">{m.conversation_mention_did_you_mean({ name })}</p>
        {candidates.map((candidate) => {
          const target = [
            candidate.label,
            several && candidate.description,
            showHandle?.has(mentionKey(candidate)) && `@${candidate.handle}`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Button
              key={mentionKey(candidate)}
              size="xs"
              color="secondary"
              aria-label={m.conversation_mention_did_you_mean_pick({ target })}
              onClick={() => onPick(candidate)}
            >
              {target}
            </Button>
          );
        })}
      </div>
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="tertiary"
        tooltip={m.conversation_mention_did_you_mean_dismiss({ name })}
        onClick={onDismiss}
      />
    </div>
  );
}
