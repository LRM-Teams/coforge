import { createServerFn } from "@tanstack/react-start";
import { saveUserTimeZoneInputSchema } from "./settings.schemas";

import { authMiddleware } from "../../server/auth/function-auth";
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

export const getUserPreferences = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = context.user.id;
    return { timeZone: await preferences().get(userId) };
  });

export const saveUserTimeZone = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(saveUserTimeZoneInputSchema)
  .handler(async ({ data, context }) => {
    const userId = context.user.id;
    return { timeZone: await preferences().set(userId, data.timeZone) };
  });
