/**
 * Who has a CoForge tab open in a Workspace. Every browser in the app shell subscribes; the
 * `presence` Centrifugo namespace tracks each subscriber and pushes their join and leave, and
 * nothing is ever published here. Only Workspace members get its subscription token, so a
 * Computer's daemon connection never appears in it.
 */
export const workspacePresenceChannel = (workspaceId: string) =>
  `presence:workspace:${workspaceId}`;
