/**
 * The shape of a `User.username`, the one place both the allocator and the Agent-facing target
 * check read it. A username is a handle nobody has to type: people are found by name and the
 * handle is filled in for them, so it is only required to be readable and unambiguous.
 *
 * The Agent wire keeps its own, looser handle rule (`MENTION_HANDLE_PATTERN` in
 * `@lrm/coforge-sdk/internal`), which every username satisfies.
 */

/** What allocation produces: a letter first, 3 to 32 characters, no separator at either end. */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{1,30}[a-z0-9]$/;

/**
 * What a stored username may look like. Accounts created before letter-first allocation keep
 * digit-first and one-character names, and they must stay reachable by
 * `@username`, so a lookup accepts this wider shape. Every `USERNAME_PATTERN` match is one.
 */
export const STORED_USERNAME_SOURCE = "[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?";
