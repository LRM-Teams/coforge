import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "../src/server/db/repositories/user-preferences.repositories.server";

function database() {
  const connectionString = Bun.env.PREFERENCES_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("PREFERENCES_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

test("a user who never saved a preference reads the defaults, and saving keeps the rest", async () => {
  const db = database();
  const user = await db.user.create({
    data: { username: `preferences-${crypto.randomUUID()}` },
  });
  try {
    const preferences = new UserPreferences(new PrismaUserPreferencesRepository(db));

    expect(await preferences.get(user.id)).toBeNull();
    expect(await preferences.getBrowserNotificationsEnabled(user.id)).toBeFalse();
    expect(await preferences.getConversationOpenMode(user.id)).toBe("first-unread");

    expect(await preferences.set(user.id, "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(await preferences.setBrowserNotificationsEnabled(user.id, true)).toBeTrue();
    expect(await preferences.setConversationOpenMode(user.id, "newest-unread")).toBe(
      "newest-unread",
    );

    expect(await preferences.get(user.id)).toBe("Asia/Tokyo");
    expect(await preferences.getBrowserNotificationsEnabled(user.id)).toBeTrue();
    expect(await preferences.getConversationOpenMode(user.id)).toBe("newest-unread");

    expect(await preferences.getTimeFormat(user.id)).toBeNull();
    expect(await preferences.setTimeFormat(user.id, "24h")).toBe("24h");
    expect(await preferences.getTimeFormat(user.id)).toBe("24h");

    expect(await preferences.set(user.id, null)).toBeNull();
    expect(await preferences.getConversationOpenMode(user.id)).toBe("newest-unread");
  } finally {
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("preferences are removed with their user and reject values outside their set", async () => {
  const db = database();
  const user = await db.user.create({
    data: { username: `preferences-${crypto.randomUUID()}` },
  });
  try {
    const insert = (mode: string) =>
      db.$executeRaw`INSERT INTO "user_preferences" ("userId", "conversationOpenMode", "updatedAt")
        VALUES (${user.id}::uuid, ${mode}, now())`;
    await expect(Promise.resolve(insert("sideways"))).rejects.toThrow(
      "user_preferences_conversationOpenMode_check",
    );
    expect(await insert("newest-read")).toBe(1);
    await expect(
      Promise.resolve(
        db.$executeRaw`UPDATE "user_preferences" SET "timeFormat" = '25h' WHERE "userId" = ${user.id}::uuid`,
      ),
    ).rejects.toThrow("user_preferences_timeFormat_check");

    await new UserPreferences(new PrismaUserPreferencesRepository(db)).set(user.id, "UTC");
    await db.user.delete({ where: { id: user.id } });
    const [{ count }] = await db.$queryRaw<[{ count: bigint }]>`
      SELECT count(*) FROM "user_preferences" WHERE "userId" = ${user.id}::uuid`;
    expect(count).toBe(0n);
  } finally {
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
});
