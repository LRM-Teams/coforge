import type { Prisma, PrismaClient } from "../../../../generated/client";

import { validateTimeZone } from "../../../lib/dates";
import { AppError } from "../../../lib/app-error";
import {
  isConversationOpenMode,
  DEFAULT_CONVERSATION_OPEN_MODE,
} from "../../../features/settings/conversation-open-mode";

export type UserPreferencesRepository = {
  getTimeZone(userId: string): Promise<string | null>;
  setTimeZone(userId: string, timeZone: string | null): Promise<string | null>;
  getBrowserNotificationsEnabled(userId: string): Promise<boolean>;
  setBrowserNotificationsEnabled(userId: string, enabled: boolean): Promise<boolean>;
  getConversationOpenMode(userId: string): Promise<string>;
  setConversationOpenMode(userId: string, mode: string): Promise<string>;
};

type PreferenceValues = Omit<
  Prisma.UserPreferenceUncheckedCreateInput,
  "userId" | "createdAt" | "updatedAt"
>;

export class PrismaUserPreferencesRepository implements UserPreferencesRepository {
  constructor(private readonly db: PrismaClient) {}

  /** A user without a row has never saved a preference, so every setting reads as its default. */
  private read(userId: string) {
    return this.db.userPreference.findUnique({ where: { userId } });
  }

  private write(userId: string, data: PreferenceValues) {
    return this.db.userPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  async getTimeZone(userId: string) {
    return (await this.read(userId))?.timeZone ?? null;
  }

  async setTimeZone(userId: string, timeZone: string | null) {
    return (await this.write(userId, { timeZone })).timeZone;
  }

  async getBrowserNotificationsEnabled(userId: string) {
    return (await this.read(userId))?.browserNotificationsEnabled ?? false;
  }

  async setBrowserNotificationsEnabled(userId: string, enabled: boolean) {
    return (
      (await this.write(userId, { browserNotificationsEnabled: enabled }))
        .browserNotificationsEnabled === true
    );
  }

  async getConversationOpenMode(userId: string) {
    return (await this.read(userId))?.conversationOpenMode ?? DEFAULT_CONVERSATION_OPEN_MODE;
  }

  async setConversationOpenMode(userId: string, mode: string) {
    const saved = await this.write(userId, { conversationOpenMode: mode });
    return saved.conversationOpenMode ?? DEFAULT_CONVERSATION_OPEN_MODE;
  }
}

export class UserPreferences {
  constructor(private readonly repository: UserPreferencesRepository) {}

  get(userId: string) {
    return this.repository.getTimeZone(userId);
  }

  async set(userId: string, timeZone: string | null) {
    return this.repository.setTimeZone(
      userId,
      timeZone === null ? null : validateTimeZone(timeZone),
    );
  }

  getBrowserNotificationsEnabled(userId: string) {
    return this.repository.getBrowserNotificationsEnabled(userId);
  }

  setBrowserNotificationsEnabled(userId: string, enabled: boolean) {
    return this.repository.setBrowserNotificationsEnabled(userId, enabled);
  }

  getConversationOpenMode(userId: string) {
    return this.repository.getConversationOpenMode(userId);
  }

  async setConversationOpenMode(userId: string, mode: string) {
    if (!isConversationOpenMode(mode)) throw new AppError("INVALID_INPUT");
    return this.repository.setConversationOpenMode(userId, mode);
  }
}
