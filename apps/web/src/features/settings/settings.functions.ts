import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { saveDateTimePreferencesInputSchema } from "./settings.schemas";

import { authMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "#src/server/db/repositories/user-preferences.repositories.server";
import { CONVERSATION_OPEN_MODES } from "./conversation-open-mode";

function preferences() {
  const db = requireDatabaseClient();
  return new UserPreferences(new PrismaUserPreferencesRepository(db));
}

export const getUserPreferences = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = context.user.id;
    return {
      timeZone: await preferences().get(userId),
      timeFormat: await preferences().getTimeFormat(userId),
      conversationOpenMode: await preferences().getConversationOpenMode(userId),
    };
  });

/** The Language & region page saves its Date & time group as one unit. */
export const saveDateTimePreferences = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(saveDateTimePreferencesInputSchema)
  .handler(async ({ data, context }) => {
    const userId = context.user.id;
    return {
      timeZone: await preferences().set(userId, data.timeZone),
      timeFormat: await preferences().setTimeFormat(userId, data.timeFormat),
    };
  });

export const saveConversationOpenMode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ mode: z.enum(CONVERSATION_OPEN_MODES) }))
  .handler(async ({ data, context }) => {
    const userId = context.user.id;
    return { conversationOpenMode: await preferences().setConversationOpenMode(userId, data.mode) };
  });
