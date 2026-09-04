import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { saveUserTimeZoneInputSchema } from "./settings.schemas";

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
  .validator(saveUserTimeZoneInputSchema)
  .handler(async ({ data }) => {
    const userId = currentUserId();
    return { timeZone: await preferences().set(userId, data.timeZone) };
  });
