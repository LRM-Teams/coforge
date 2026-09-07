import { z } from "zod";

const base64Url = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .length(Math.ceil((bytes * 8) / 6));

function isSafePushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      value.startsWith("https://") &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export const browserNotificationPreferenceInput = z.object({
  enabled: z.boolean(),
});

export const browserPushSubscriptionInput = z.object({
  endpoint: z.string().max(4_096).refine(isSafePushEndpoint),
  expirationTime: z.number().int().positive().nullable(),
  keys: z.object({ p256dh: base64Url(65), auth: base64Url(16) }),
});

export const browserPushUnsubscribeInput = z.object({
  endpoint: z.string().max(4_096).refine(isSafePushEndpoint),
});

export const browserPushTestInput = browserPushUnsubscribeInput;
