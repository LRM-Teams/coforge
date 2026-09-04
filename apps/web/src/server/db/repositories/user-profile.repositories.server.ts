import type { PrismaClient } from "../../../../generated/client";
import { AppError } from "../../../lib/app-error";

export class PrismaUserProfileRepository {
  constructor(private readonly db: PrismaClient) {}

  async get(userId: string) {
    const profile = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
      },
    });
    if (!profile) throw new AppError("NOT_FOUND");
    return {
      username: profile.username,
      displayName: profile.displayName,
      description: profile.description,
      avatarUrl: avatarUrl(profile.avatarObjectKey),
    };
  }

  async set(userId: string, input: { name: string; description: string }) {
    const profile = await this.db.user.update({
      where: { id: userId },
      data: { displayName: input.name, description: input.description },
      select: { description: true },
    });
    return { name: input.name, description: profile.description };
  }
}

export function avatarUrl(objectKey: string | null) {
  if (!objectKey) return null;
  const version = objectKey.split("/").at(-2);
  return `/api/me/avatar?v=${encodeURIComponent(version ?? "current")}`;
}
