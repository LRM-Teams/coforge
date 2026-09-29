import { Avatar } from "#src/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import type { ThreadedConversationProps } from "./conversation-types";
import { ThreadedConversation } from "./threaded-conversation";

/**
 * The stream both kinds of direct message share: named after the other side (`@name` over each
 * thread, `name` on the Task popup), with that side's large avatar on the empty state. Each kind
 * brings its own header, identity and copy.
 */
export function DirectThreadedConversation({
  name,
  emptyState: { avatar, ...emptyState },
  ...props
}: Omit<ThreadedConversationProps, "conversationName" | "threadContext" | "emptyState"> & {
  /** The other side's name, as the conversation is called. */
  name: string;
  emptyState: {
    title: string;
    description: string;
    avatar: { name: string; src?: string | null };
  };
}) {
  return (
    <ThreadedConversation
      {...props}
      conversationName={name}
      threadContext={`@${name}`}
      emptyState={{
        ...emptyState,
        media: (
          <Avatar
            size="2xl"
            alt={avatar.name}
            src={avatar.src ?? undefined}
            initials={avatarInitial(avatar.name)}
            contentClassName={avatarToneClassName(avatar.name)}
            className="ring-1 ring-secondary"
          />
        ),
      }}
    />
  );
}
