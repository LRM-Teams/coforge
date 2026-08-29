import type { PrismaClient } from "../../../generated/client";

export class UserIdentityRepository {
  constructor(private readonly db: PrismaClient) {}

  async resolve(
    provider: string,
    providerSubject: string,
    profile?: { email?: string | null; preferredUsername?: string | null },
  ) {
    const identity = await this.db.userIdentity.findUnique({
      where: { provider_providerSubject: { provider, providerSubject } },
      include: { user: true },
    });
    if (identity) return identity.user;
    const id = crypto.randomUUID();
    const preferred = validUsername(profile?.preferredUsername);
    const local = normalizeUsername(profile?.email?.split("@", 1)[0] ?? "") || "user";
    const suffix = id.replaceAll("-", "").slice(0, 8);
    const candidates = [preferred, `${local}-${suffix}`, `user-${id.replaceAll("-", "")}`].filter(
      (candidate): candidate is string => Boolean(candidate),
    );
    for (const username of candidates) {
      const collision = await this.db.user.findUnique({
        where: { username },
        select: { id: true },
      });
      if (collision) continue;
      return this.db.user.create({
        data: { id, username, identities: { create: { provider, providerSubject } } },
      });
    }
    throw new Error("could not allocate username");
  }
}

const USERNAME = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/;
function validUsername(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && USERNAME.test(normalized) ? normalized : undefined;
}
function normalizeUsername(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 23);
}
