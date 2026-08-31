import type { PrismaClient } from "../../../../generated/client";

import { validateTimeZone } from "../../../lib/dates";

export type UserPreferencesRepository = {
  getTimeZone(userId: string): Promise<string | null>;
  setTimeZone(userId: string, timeZone: string | null): Promise<string | null>;
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
}
