import { humanLabel, type HumanNames } from "#src/lib/human-label";

/**
 * What "Signed in as ..." calls an account: the email its sign-in reported, or, for an account
 * with none (a phone-number sign-up), the person's name (`humanLabel`). Never a phone number, and
 * never an `@username`: the names come from the database, since the provider's own name is only a
 * suggestion for the first-sign-in name field.
 */
export function accountLabel(user: { email: string | null } & HumanNames): string {
  return user.email ?? humanLabel(user);
}
