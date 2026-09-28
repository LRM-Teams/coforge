import { AppError } from "#src/lib/app-error";

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CONTENT_SIGNATURES = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
} as const;

export async function validateImage(file: File) {
  const signature = CONTENT_SIGNATURES[file.type as keyof typeof CONTENT_SIGNATURES];
  if (!signature || file.size === 0 || file.size > IMAGE_MAX_BYTES)
    throw new AppError("INVALID_INPUT");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = signature.every((byte, index) => bytes[index] === byte);
  const webpMatches =
    file.type !== "image/webp" || String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!matches || !webpMatches) throw new AppError("INVALID_INPUT");
}
