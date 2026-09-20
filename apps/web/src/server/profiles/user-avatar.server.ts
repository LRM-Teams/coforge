import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { avatarUrl } from "../db/repositories/user-profile.repositories.server";
import type { FileStorage } from "../files/file-storage.server";
import { getPublicImageStorage } from "../files/public-image-storage.server";
import { validateImage } from "../files/image-upload.server";

export { IMAGE_MAX_BYTES as PROFILE_IMAGE_MAX_BYTES } from "../files/image-upload.server";

export async function storeUserAvatar(
  db: PrismaClient,
  input: { userId: string; file: File },
  storage: () => Promise<FileStorage> = getPublicImageStorage,
) {
  await validateImage(input.file);
  const previous = await db.user.findUnique({
    where: { id: input.userId },
    select: { avatarObjectKey: true },
  });
  if (!previous) throw new AppError("NOT_FOUND");

  const id = crypto.randomUUID();
  const objectKey = `users/${input.userId}/avatars/${id}/original`;
  const files = await storage();
  await files.put(objectKey, input.file, input.file.type);
  try {
    await db.user.update({
      where: { id: input.userId },
      data: { avatarObjectKey: objectKey, avatarContentType: input.file.type },
    });
  } catch (error) {
    await files.remove(objectKey);
    throw error;
  }
  if (previous.avatarObjectKey) await files.remove(previous.avatarObjectKey);
  return { avatarUrl: avatarUrl(objectKey) };
}

export async function readUserAvatar(
  db: PrismaClient,
  userId: string,
  storage: () => Promise<FileStorage> = getPublicImageStorage,
) {
  const profile = await db.user.findUnique({
    where: { id: userId },
    select: { avatarObjectKey: true, avatarContentType: true },
  });
  if (!profile?.avatarObjectKey || !profile.avatarContentType) throw new AppError("NOT_FOUND");
  const file = await (await storage()).open(profile.avatarObjectKey);
  if (!file) throw new AppError("NOT_FOUND");
  return { body: file.body, contentType: profile.avatarContentType };
}

export async function removeUserAvatar(
  db: PrismaClient,
  userId: string,
  storage: () => Promise<FileStorage> = getPublicImageStorage,
) {
  const previous = await db.user.findUnique({
    where: { id: userId },
    select: { avatarObjectKey: true },
  });
  if (!previous) throw new AppError("NOT_FOUND");
  await db.user.update({
    where: { id: userId },
    data: { avatarObjectKey: null, avatarContentType: null },
  });
  if (previous.avatarObjectKey) await (await storage()).remove(previous.avatarObjectKey);
}
