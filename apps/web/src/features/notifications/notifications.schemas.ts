import { z } from "zod";

const base64Url = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .length(Math.ceil((bytes * 8) / 6));

function isSupportedPushEndpoint(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (hostname === "fcm.googleapis.com" ||
        hostname === "updates.push.services.mozilla.com" ||
        hostname === "web.push.apple.com" ||
        hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}

export const browserNotificationPreferenceInput = z.object({ enabled: z.boolean() });

export const browserPushSubscriptionInput = z.object({
  endpoint: z.string().max(4_096).refine(isSupportedPushEndpoint),
  expirationTime: z.number().int().positive().nullable(),
  keys: z.object({ p256dh: base64Url(65), auth: base64Url(16) }),
});

export const browserPushUnsubscribeInput = z.object({
  endpoint: z.string().max(4_096).refine(isSupportedPushEndpoint),
});

export const browserPushTestInput = browserPushUnsubscribeInput;
