import { addCalendarDays } from "#src/lib/dates";

/** The use limits and lifetimes (in days) a join link can be given, as Raft offers them. */
export const JOIN_LINK_USE_LIMITS = [1, 5, 10, 25] as const;
export const JOIN_LINK_LIFETIME_DAYS = [1, 7, 30] as const;

/** "keep" leaves the current link's setting as it is. */
export type JoinLinkMaxUsesChoice = "keep" | "unlimited" | (typeof JOIN_LINK_USE_LIMITS)[number];
export type JoinLinkExpiryChoice = "keep" | "never" | (typeof JOIN_LINK_LIFETIME_DAYS)[number];
export type JoinLinkChoices = { maxUses: JoinLinkMaxUsesChoice; expiry: JoinLinkExpiryChoice };

type CurrentLink = { maxUses: number | null; expiresAt: Date | null } | null;

/** A setting the link has starts at "keep"; one it lacks starts at no limit or never. */
export function defaultJoinLinkChoices(link: CurrentLink): JoinLinkChoices {
  return {
    maxUses: link?.maxUses != null ? "keep" : "unlimited",
    expiry: link?.expiresAt ? "keep" : "never",
  };
}

/** The options a create or update sends: a lifetime counts calendar days from `now` on the
 * viewer's wall clock in `timeZone`. */
export function joinLinkOptions(
  choices: JoinLinkChoices,
  current: CurrentLink,
  now: Date,
  timeZone: string | null | undefined,
): { maxUses: number | null; expiresAt: string | null } {
  const maxUses =
    choices.maxUses === "keep"
      ? (current?.maxUses ?? null)
      : choices.maxUses === "unlimited"
        ? null
        : choices.maxUses;
  let expiresAt: string | null;
  if (choices.expiry === "keep") {
    expiresAt = current?.expiresAt ? current.expiresAt.toISOString() : null;
  } else if (choices.expiry === "never") {
    expiresAt = null;
  } else {
    expiresAt = addCalendarDays(now, choices.expiry, timeZone).toISOString();
  }
  return { maxUses, expiresAt };
}
