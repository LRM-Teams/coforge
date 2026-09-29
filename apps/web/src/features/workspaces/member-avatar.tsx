import { Avatar, type AvatarProps } from "#src/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { useMemberOnline } from "./member-presence";

/** A Workspace member's avatar with their online dot, wherever a member is shown by face. */
export function MemberAvatar({
  userId,
  name,
  src,
  size,
}: {
  userId: string;
  name: string;
  src: string | null;
  size: AvatarProps["size"];
}) {
  const online = useMemberOnline(userId);
  return (
    <Avatar
      size={size}
      alt={name}
      src={src ?? undefined}
      initials={avatarInitial(name)}
      contentClassName={avatarToneClassName(name)}
      // No dot until presence is known: an unknown state is never drawn as offline.
      status={online === undefined ? undefined : online ? "online" : "offline"}
    />
  );
}
