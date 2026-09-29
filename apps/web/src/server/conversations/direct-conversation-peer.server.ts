import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

/** Who a DM is with, as every DM surface (the sidebar, the Activity inbox) shows it: the viewer's
 * Agent, or a member (the viewer themself in their own). */
export type DirectConversationPeer =
  | { kind: "agent"; agentId: string }
  | {
      kind: "people";
      userId: string;
      username: string;
      /** The member's display name, or their username when they have none. */
      displayName: string;
      avatarUrl: string | null;
    };

/** The fields a people peer is built from (`peoplePeer`). */
export const peoplePeerUserFields = {
  id: true,
  username: true,
  displayName: true,
  avatarObjectKey: true,
} as const;

/** The member on the other side of a DM between people, as every DM surface shows them. */
export function peoplePeer(
  workspaceId: string,
  person: {
    id: string;
    username: string;
    displayName: string | null;
    avatarObjectKey: string | null;
  },
): Extract<DirectConversationPeer, { kind: "people" }> {
  return {
    kind: "people",
    userId: person.id,
    username: person.username,
    displayName: person.displayName?.trim() || person.username,
    avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
  };
}
