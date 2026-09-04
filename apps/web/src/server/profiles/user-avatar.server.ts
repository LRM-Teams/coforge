import { mkdir, rm } from "node:fs/promises";

import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { avatarUrl } from "../db/repositories/user-profile.repositories.server";
import { fileStoragePath } from "../files/file-storage.server";

export const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CONTENT_SIGNATURES = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
} as const;

export async function storeUserAvatar(db: PrismaClient, input: { userId: string; file: File }) {
  await validateImage(input.file);
  const previous = await db.user.findUnique({
    where: { id: input.userId },
    select: { avatarObjectKey: true },
  });
  if (!previous) throw new AppError("NOT_FOUND");

  const id = crypto.randomUUID();
  const objectKey = `users/${input.userId}/avatars/${id}/original`;
  const path = fileStoragePath(objectKey);
  await mkdir(fileStoragePath(`users/${input.userId}/avatars/${id}`), { recursive: true });
  await Bun.write(path, input.file);
  try {
    await db.user.update({
      where: { id: input.userId },
      data: { avatarObjectKey: objectKey, avatarContentType: input.file.type },
    });
  } catch (error) {
    await rm(fileStoragePath(`users/${input.userId}/avatars/${id}`), {
      recursive: true,
      force: true,
    });
    throw error;
  }
  if (previous.avatarObjectKey) await removeObject(previous.avatarObjectKey);
  return { avatarUrl: avatarUrl(objectKey) };
}

export async function readUserAvatar(db: PrismaClient, userId: string) {
  const profile = await db.user.findUnique({
    where: { id: userId },
    select: { avatarObjectKey: true, avatarContentType: true },
  });
  if (!profile?.avatarObjectKey || !profile.avatarContentType) throw new AppError("NOT_FOUND");
  const file = Bun.file(fileStoragePath(profile.avatarObjectKey));
  if (!(await file.exists())) throw new AppError("NOT_FOUND");
  return { body: file, contentType: profile.avatarContentType };
}

export async function removeUserAvatar(db: PrismaClient, userId: string) {
  const previous = await db.user.findUnique({
    where: { id: userId },
    select: { avatarObjectKey: true },
  });
  if (!previous) throw new AppError("NOT_FOUND");
  await db.user.update({
    where: { id: userId },
    data: { avatarObjectKey: null, avatarContentType: null },
  });
  if (previous.avatarObjectKey) await removeObject(previous.avatarObjectKey);
}

async function validateImage(file: File) {
  const signature = CONTENT_SIGNATURES[file.type as keyof typeof CONTENT_SIGNATURES];
  if (!signature || file.size === 0 || file.size > PROFILE_IMAGE_MAX_BYTES)
    throw new AppError("INVALID_INPUT");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = signature.every((byte, index) => bytes[index] === byte);
  const webpMatches =
    file.type !== "image/webp" || String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!matches || !webpMatches) throw new AppError("INVALID_INPUT");
}

async function removeObject(objectKey: string) {
  await rm(fileStoragePath(objectKey).replace(/\/original$/, ""), { recursive: true, force: true });
}
