import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { saveUserTimeZoneInputSchema } from "./settings.schemas";

import { authMiddleware } from "../../server/auth/function-auth";
import { requireDatabaseClient } from "../../server/db/client.server";
import {
  PrismaUserPreferencesRepository,
  UserPreferences,
} from "../../server/db/repositories/user-preferences.repositories.server";
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
      conversationOpenMode: await preferences().getConversationOpenMode(userId),
    };
  });

export const saveUserTimeZone = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(saveUserTimeZoneInputSchema)
  .handler(async ({ data, context }) => {
    const userId = context.user.id;
    return { timeZone: await preferences().set(userId, data.timeZone) };
  });

export const saveConversationOpenMode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ mode: z.enum(CONVERSATION_OPEN_MODES) }))
  .handler(async ({ data, context }) => {
    const userId = context.user.id;
    return { conversationOpenMode: await preferences().setConversationOpenMode(userId, data.mode) };
  });
