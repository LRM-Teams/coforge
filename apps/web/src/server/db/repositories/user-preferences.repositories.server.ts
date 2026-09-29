import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

import { validateTimeZone } from "#src/lib/dates";
import { AppError } from "#src/lib/app-error";
import { isTimeFormat } from "#src/lib/time-format";
import {
  isConversationOpenMode,
  DEFAULT_CONVERSATION_OPEN_MODE,
} from "#src/features/settings/conversation-open-mode";

/** The settings every page reads together, as stored: one row, so one read. */
export type StoredUserPreferences = {
  timeZone: string | null;
  timeFormat: string | null;
  conversationOpenMode: string;
};

export type UserPreferencesRepository = {
  read(userId: string): Promise<StoredUserPreferences>;
  setTimeZone(userId: string, timeZone: string | null): Promise<string | null>;
  getBrowserNotificationsEnabled(userId: string): Promise<boolean>;
  setBrowserNotificationsEnabled(userId: string, enabled: boolean): Promise<boolean>;
  setConversationOpenMode(userId: string, mode: string): Promise<string>;
  setTimeFormat(userId: string, timeFormat: string | null): Promise<string | null>;
};

type PreferenceValues = Omit<
  Prisma.UserPreferenceUncheckedCreateInput,
  "userId" | "createdAt" | "updatedAt"
>;

export class PrismaUserPreferencesRepository implements UserPreferencesRepository {
  constructor(private readonly db: PrismaClient) {}

  /** A user without a row has never saved a preference, so every setting reads as its default. */
  private row(userId: string) {
    return this.db.userPreference.findUnique({ where: { userId } });
  }

  async read(userId: string) {
    const row = await this.row(userId);
    return {
      timeZone: row?.timeZone ?? null,
      timeFormat: row?.timeFormat ?? null,
      conversationOpenMode: row?.conversationOpenMode ?? DEFAULT_CONVERSATION_OPEN_MODE,
    };
  }

  private write(userId: string, data: PreferenceValues) {
    return this.db.userPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  async setTimeZone(userId: string, timeZone: string | null) {
    return (await this.write(userId, { timeZone })).timeZone;
  }

  async getBrowserNotificationsEnabled(userId: string) {
    return (await this.row(userId))?.browserNotificationsEnabled ?? false;
  }

  async setBrowserNotificationsEnabled(userId: string, enabled: boolean) {
    return (
      (await this.write(userId, { browserNotificationsEnabled: enabled }))
        .browserNotificationsEnabled === true
    );
  }

  async setConversationOpenMode(userId: string, mode: string) {
    const saved = await this.write(userId, { conversationOpenMode: mode });
    return saved.conversationOpenMode ?? DEFAULT_CONVERSATION_OPEN_MODE;
  }

  async setTimeFormat(userId: string, timeFormat: string | null) {
    return (await this.write(userId, { timeFormat })).timeFormat;
  }
}

export class UserPreferences {
  constructor(private readonly repository: UserPreferencesRepository) {}

  /** The time zone, time format and conversation open mode, read together. */
  async read(userId: string) {
    const stored = await this.repository.read(userId);
    return {
      timeZone: stored.timeZone,
      timeFormat: isTimeFormat(stored.timeFormat) ? stored.timeFormat : null,
      conversationOpenMode: stored.conversationOpenMode,
    };
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

  async setConversationOpenMode(userId: string, mode: string) {
    if (!isConversationOpenMode(mode)) throw new AppError("INVALID_INPUT");
    return this.repository.setConversationOpenMode(userId, mode);
  }

  async setTimeFormat(userId: string, timeFormat: string | null) {
    if (timeFormat !== null && !isTimeFormat(timeFormat)) throw new AppError("INVALID_INPUT");
    return this.repository.setTimeFormat(userId, timeFormat);
  }
}
