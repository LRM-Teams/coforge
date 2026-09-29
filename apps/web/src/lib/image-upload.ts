/**
 * The uploaded-image rule a browser can check before sending: an avatar or icon is a JPEG, PNG or
 * WebP of at most 5 MB. `server/files/image-upload.server.ts` enforces the same rule on the bytes.
 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
