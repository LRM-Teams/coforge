import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { UserIdentityRepository } from "#src/server/auth/user-identity.repository.server";

/**
 * The login identity repository against local PostgreSQL: each successful browser login leaves
 * the provider's latest email on the User, while the User is still matched only by provider and
 * subject. The email is a stored fact, never a key that links two identities.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type LoginProfile = {
  email?: string | null;
  preferredUsername?: string | null;
  name?: string | null;
  nickname?: string | null;
};

async function setup() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
    log: [{ emit: "event", level: "query" }],
  });
  const statements: string[] = [];
  db.$on("query", (event) => statements.push(event.query));
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const login = async (subject: string, profile?: LoginProfile) => {
    const user = await new UserIdentityRepository(db).resolve("authing", subject, profile);
    userIds.push(user.id);
    return user;
  };
  const storedEmail = async (userId: string) =>
    (await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;
  const userWrites = () =>
    statements.filter((query) => query.startsWith('UPDATE "public"."users"'));
  const teardown = async () => {
    await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, suffix, userIds, login, storedEmail, userWrites, teardown };
}

test.skipIf(!connectionString)("a first login stores the email the provider reported", async () => {
  const { suffix, login, storedEmail, teardown } = await setup();
  try {
    const user = await login(`sub-first-${suffix}`, { email: `ada-${suffix}@example.com` });

    expect(user.email).toBe(`ada-${suffix}@example.com`);
    expect(await storedEmail(user.id)).toBe(`ada-${suffix}@example.com`);
  } finally {
    await teardown();
  }
});

test.skipIf(!connectionString)(
  "a later login with a different email updates the same User's email",
  async () => {
    const { suffix, login, storedEmail, userWrites, teardown } = await setup();
    try {
      const first = await login(`sub-change-${suffix}`, { email: `old-${suffix}@example.com` });
      const before = userWrites().length;

      const second = await login(`sub-change-${suffix}`, { email: `new-${suffix}@example.com` });

      expect(second.id).toBe(first.id);
      expect(second.email).toBe(`new-${suffix}@example.com`);
      expect(await storedEmail(first.id)).toBe(`new-${suffix}@example.com`);
      expect(userWrites().length - before).toBe(1);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)("a later login with the same email writes nothing", async () => {
  const { suffix, login, storedEmail, userWrites, teardown } = await setup();
  try {
    const first = await login(`sub-same-${suffix}`, { email: `same-${suffix}@example.com` });
    const before = userWrites().length;

    const second = await login(`sub-same-${suffix}`, { email: `same-${suffix}@example.com` });

    expect(second.id).toBe(first.id);
    expect(await storedEmail(first.id)).toBe(`same-${suffix}@example.com`);
    expect(userWrites().length - before).toBe(0);
  } finally {
    await teardown();
  }
});

test.skipIf(!connectionString)(
  "a login that reports no email keeps the stored one and creates a User without one",
  async () => {
    const { suffix, login, storedEmail, teardown } = await setup();
    try {
      const known = await login(`sub-known-${suffix}`, { email: `kept-${suffix}@example.com` });
      await login(`sub-known-${suffix}`, { email: null });
      await login(`sub-known-${suffix}`);
      const anonymous = await login(`sub-anonymous-${suffix}`);

      expect(await storedEmail(known.id)).toBe(`kept-${suffix}@example.com`);
      expect(await storedEmail(anonymous.id)).toBeNull();
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the email is not an identity key: another subject with the same email is another User",
  async () => {
    const { suffix, login, storedEmail, teardown } = await setup();
    try {
      const email = `shared-${suffix}@example.com`;
      const original = await login(`sub-pool-a-${suffix}`, { email });
      const other = await login(`sub-pool-b-${suffix}`, { email });

      expect(other.id).not.toBe(original.id);
      expect(await storedEmail(original.id)).toBe(email);
      expect(await storedEmail(other.id)).toBe(email);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a preferred_username of 11 or more digits is a phone number, and never becomes the username",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      // Sign-up by phone number and nothing else: the username is the generated one.
      const phoneOnly = await login(`sub-phone-only-${suffix}`, {
        preferredUsername: " 13800138000 ",
      });
      expect(phoneOnly.username).toMatch(/^user(-\d+)?$/);
      expect(phoneOnly.username).not.toContain("13800138000");
      expect(phoneOnly.email).toBeNull();

      // With an email as well, the email's local part names the account, not the phone number.
      const withEmail = await login(`sub-phone-email-${suffix}`, {
        email: `ada-${suffix}@example.com`,
        preferredUsername: "13800138000",
      });
      expect(withEmail.username).toBe(`ada-${suffix}`);
      expect(withEmail.username).not.toContain("13800138000");
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a phone number hidden among letters or separators never becomes the username",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const wechat = await login(`sub-wx-${suffix}`, {
        preferredUsername: "wx13800138000",
        email: `wx-${suffix}@example.com`,
      });
      const spaced = await login(`sub-spaced-${suffix}`, {
        name: "Tel 138-0013-8000",
        nickname: `Grace ${suffix}`,
      });

      expect(wechat.username).toBe(`wx-${suffix}`);
      expect(spaced.username).toBe(`grace-${suffix}`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a preferred_username that is a name, even with digits in it, is still the username",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const named = await login(`sub-named-${suffix}`, { preferredUsername: `ada2024-${suffix}` });

      expect(named.username).toBe(`ada2024-${suffix}`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a first login gets a readable username from the email's local part, and no full name yet",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const plain = await login(`sub-readable-${suffix}`, { email: `Grace-${suffix}@example.com` });
      const tagged = await login(`sub-tagged-${suffix}`, {
        email: `ada-${suffix}+newsletter@example.com`,
      });

      expect(plain.username).toBe(`grace-${suffix}`);
      expect(tagged.username).toBe(`ada-${suffix}`);
      expect(plain.fullName).toBeNull();
      expect(plain.displayName).toBeNull();
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a taken username takes the smallest free -N, and only its own -N counts as a collision",
  async () => {
    const { db, suffix, userIds, login, teardown } = await setup();
    try {
      const email = `lee-${suffix}@example.com`;
      // Names that merely start with the base, or carry the older hex suffix, do not block it.
      for (const username of [`lee-${suffix}-d9956ab1`, `lee-${suffix}x`, `lee-${suffix}-2x`]) {
        userIds.push((await db.user.create({ data: { username } })).id);
      }

      const first = await login(`sub-lee-1-${suffix}`, { email });
      const second = await login(`sub-lee-2-${suffix}`, { email });
      const third = await login(`sub-lee-3-${suffix}`, { email });
      await db.user.delete({ where: { id: second.id } });
      const refilled = await login(`sub-lee-4-${suffix}`, { email });

      expect(first.username).toBe(`lee-${suffix}`);
      expect(second.username).toBe(`lee-${suffix}-2`);
      expect(third.username).toBe(`lee-${suffix}-3`);
      expect(refilled.username).toBe(`lee-${suffix}-2`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "people who sign in at the same moment with the same base each get a distinct username",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const email = `race-${suffix}@example.com`;
      const users = await Promise.all(
        [1, 2, 3, 4].map((n) => login(`sub-race-${n}-${suffix}`, { email })),
      );

      expect(users.map((user) => user.username).sort()).toEqual([
        `race-${suffix}`,
        `race-${suffix}-2`,
        `race-${suffix}-3`,
        `race-${suffix}-4`,
      ]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the same person's two callbacks at the same moment resolve to one User",
  async () => {
    const { db, suffix, login, teardown } = await setup();
    try {
      const subject = `sub-twice-${suffix}`;
      const email = `twice-${suffix}@example.com`;
      const [first, second] = await Promise.all([
        login(subject, { email }),
        login(subject, { email }),
      ]);

      expect(second.id).toBe(first.id);
      expect(second.username).toBe(first.username);
      expect(await db.userIdentity.count({ where: { providerSubject: subject } })).toBe(1);
      expect(await db.user.count({ where: { username: { startsWith: `twice-${suffix}` } } })).toBe(
        1,
      );
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a username starts with a letter: a digit start gets the prefix u, an 11-digit one is skipped",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const digits = String(1_000_000_000 + Math.floor(Math.random() * 9_000_000_000));
      const qq = await login(`sub-qq-${suffix}`, { preferredUsername: digits });
      const byEmail = await login(`sub-qq-email-${suffix}`, {
        email: `${digits}@example.com`,
        name: `Ada ${suffix}`,
      });
      const phone = await login(`sub-phone-name-${suffix}`, {
        email: `13800138000@example.com`,
        name: `Grace ${suffix}`,
      });

      expect(qq.username).toBe(`u${digits}`);
      expect(byEmail.username).toBe(`u${digits}-2`);
      expect(phone.username).toBe(`grace-${suffix}`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a reserved word is never a username, and the next source is used",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const user = await login(`sub-reserved-${suffix}`, {
        preferredUsername: "admin",
        email: "everyone@example.com",
        name: `Grace Hopper ${suffix}`,
      });
      const bare = await login(`sub-reserved-bare-${suffix}`, {
        preferredUsername: "system",
        email: "settings@example.com",
      });

      expect(user.username).toBe(`grace-hopper-${suffix}`);
      expect(bare.username).toMatch(/^user(-\d+)?$/);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a name with no ASCII letters yields no username, so the nickname or the fallback is used",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const nickname = await login(`sub-cjk-nick-${suffix}`, {
        name: "安栋",
        nickname: `Dong ${suffix}`,
      });
      const cjkOnly = await login(`sub-cjk-only-${suffix}`, { name: "安栋", nickname: "安栋" });

      expect(nickname.username).toBe(`dong-${suffix}`);
      expect(cjkOnly.username).toMatch(/^user(-\d+)?$/);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "logins with nothing to name them by get distinct fallback usernames",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const users = await Promise.all([1, 2, 3].map((n) => login(`sub-nothing-${n}-${suffix}`)));

      const names = users.map((user) => user.username);
      for (const name of names) expect(name).toMatch(/^user(-\d+)?$/);
      expect(new Set(names).size).toBe(3);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a name too short to be a username is skipped, and a long one is cut so its -N still fits",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      const short = await login(`sub-short-${suffix}`, {
        preferredUsername: "ab",
        email: "ab@example.com",
      });
      const stem = `${"x".repeat(20)}${suffix}`;
      const long = { email: `${stem}@example.com` };
      const first = await login(`sub-long-1-${suffix}`, long);
      const second = await login(`sub-long-2-${suffix}`, long);

      expect(short.username).toMatch(/^user(-\d+)?$/);
      expect(first.username).toBe(stem.slice(0, 24));
      expect(second.username).toBe(`${stem.slice(0, 24)}-2`);
    } finally {
      await teardown();
    }
  },
);
