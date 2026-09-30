import type { PrismaClient } from "#src/generated/prisma/client";
import { accountLabel } from "#src/features/auth/account-label";
import type { BrowserUser } from "./browser-login.server";

/**
 * How the signed-in person's account is named on pages that say "Signed in as ...", and whether
 * they still have to be asked for a full name (`named`). The session says who signed in; the
 * names come from the database, because the session's own name is only what the provider
 * reported. A session whose user no longer exists is named by its username and not named yet.
 */
export async function signedInAccount(
  db: PrismaClient,
  user: BrowserUser,
): Promise<{ account: string; named: boolean }> {
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { fullName: true, displayName: true, username: true },
  });
  const names = row ?? { fullName: null, displayName: null, username: user.username };
  return { account: accountLabel({ email: user.email, ...names }), named: names.fullName !== null };
}
