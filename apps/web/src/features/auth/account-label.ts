/**
 * What "Signed in as ..." calls an account: the email its sign-in reported, or, for an account
 * with none (a phone-number sign-up), its `@username`. Never a phone number.
 */
export function accountLabel(user: { email: string | null; username: string }): string {
  return user.email ?? `@${user.username}`;
}
