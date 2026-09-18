import type { PrismaClient } from "../../../../generated/client";

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

export class PrismaUserPreferencesRepository implements UserPreferencesRepository {
  constructor(private readonly db: PrismaClient) {}

  async getTimeZone(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { timeZone: true },
    });
    return user?.timeZone ?? null;
  }

  async setTimeZone(userId: string, timeZone: string | null) {
    const user = await this.db.user.update({
      where: { id: userId },
      data: { timeZone },
      select: { timeZone: true },
    });
    return user.timeZone;
  }

  async getBrowserNotificationsEnabled(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { browserNotificationsEnabled: true },
    });
    return user?.browserNotificationsEnabled ?? false;
  }

  async setBrowserNotificationsEnabled(userId: string, enabled: boolean) {
    const user = await this.db.user.update({
      where: { id: userId },
      data: { browserNotificationsEnabled: enabled },
      select: { browserNotificationsEnabled: true },
    });
    return user.browserNotificationsEnabled;
  }

  async getConversationOpenMode(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { conversationOpenMode: true },
    });
    return user?.conversationOpenMode ?? DEFAULT_CONVERSATION_OPEN_MODE;
  }

  async setConversationOpenMode(userId: string, mode: string) {
    const user = await this.db.user.update({
      where: { id: userId },
      data: { conversationOpenMode: mode },
      select: { conversationOpenMode: true },
    });
    return user.conversationOpenMode;
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
