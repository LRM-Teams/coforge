import type { PrismaClient } from "#src/generated/prisma/client";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { UsernameAllocator, type UsernameProfile } from "./username-allocation.server";

export class UserIdentityRepository {
  private readonly usernames: UsernameAllocator;

  constructor(private readonly db: PrismaClient) {
    this.usernames = new UsernameAllocator(async (base) =>
      (
        await this.db.user.findMany({
          where: { OR: [{ username: base }, { username: { startsWith: `${base}-` } }] },
          select: { username: true },
        })
      ).map((row) => row.username),
    );
  }

  async resolve(provider: string, providerSubject: string, profile: UsernameProfile = {}) {
    // The provider's latest email is stored on every login; it never selects the User.
    const email = profile.email || undefined;
    const identity = await this.findIdentity(provider, providerSubject);
    if (identity) {
      if (!email || identity.user.email === email) return identity.user;
      return this.db.user.update({ where: { id: identity.user.id }, data: { email } });
    }
    const id = crypto.randomUUID();
    return this.usernames.create(profile, async (username) => {
      try {
        return await this.db.user.create({
          data: {
            id,
            username,
            email,
            identities: { create: { provider, providerSubject } },
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The same person's other callback got here first: the identity is theirs, not a name
        // clash to retry. A name clash leaves no such identity and goes back to the allocator.
        const concurrent = await this.findIdentity(provider, providerSubject);
        if (concurrent) return concurrent.user;
        throw error;
      }
    });
  }

  private findIdentity(provider: string, providerSubject: string) {
    return this.db.userIdentity.findUnique({
      where: { provider_providerSubject: { provider, providerSubject } },
      include: { user: true },
    });
  }
}
