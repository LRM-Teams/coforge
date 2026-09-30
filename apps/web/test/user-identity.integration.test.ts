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

async function setup() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
    log: [{ emit: "event", level: "query" }],
  });
  const statements: string[] = [];
  db.$on("query", (event) => statements.push(event.query));
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const login = async (
    subject: string,
    profile?: { email?: string | null; preferredUsername?: string | null },
  ) => {
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
  return { suffix, login, storedEmail, userWrites, teardown };
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
  "a preferred_username made only of digits is a phone number, and never becomes the username",
  async () => {
    const { suffix, login, teardown } = await setup();
    try {
      // Sign-up by phone number and nothing else: the username is the generated one.
      const phoneOnly = await login(`sub-phone-only-${suffix}`, {
        preferredUsername: " 13800138000 ",
      });
      expect(phoneOnly.username).toMatch(/^user-[0-9a-f]{8}$/);
      expect(phoneOnly.username).not.toContain("13800138000");
      expect(phoneOnly.email).toBeNull();

      // With an email as well, the email's local part names the account, not the phone number.
      const withEmail = await login(`sub-phone-email-${suffix}`, {
        email: `ada-${suffix}@example.com`,
        preferredUsername: "13800138000",
      });
      expect(withEmail.username).toStartWith(`ada-${suffix}-`);
      expect(withEmail.username).not.toContain("13800138000");
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
