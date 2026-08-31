import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "../../server/db/repositories/user-preferences.repositories.server";

function preferences() {
  const db = getDatabaseClient();
  if (!db) throw new Error("User preferences persistence is unavailable");
  return new UserPreferences(new PrismaUserPreferencesRepository(db));
}

function currentUserId() {
  return requireBrowserUser(getRequest().headers.get("cookie") ?? undefined).id;
}

export const getUserPreferences = createServerFn({ method: "GET" }).handler(async () => {
  const userId = currentUserId();
  return { timeZone: await preferences().get(userId) };
});

export const saveUserTimeZone = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("User preferences input is required");
    const timeZone = Reflect.get(data, "timeZone");
    if (timeZone === null) return null;
    if (typeof timeZone !== "string") throw new Error("Time zone must be a string or null");
    return timeZone;
  })
  .handler(async ({ data }) => {
    const userId = currentUserId();
    return { timeZone: await preferences().set(userId, data) };
  });
