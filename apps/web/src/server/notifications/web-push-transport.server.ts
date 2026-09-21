import webPush from "web-push";

import { assertVapidKeyPair } from "./vapid-key-pair.server";
import { resolvePinnedWebPushTarget, sendPinnedWebPushRequest } from "./web-push-egress.server";
import {
  WebPushDeliveryError,
  type StoredWebPushSubscription,
  type WebPushPayload,
  type WebPushTransport,
} from "./web-push-notifications.server";

export type WebPushConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

export async function readWebPushConfig(
  environment: Record<string, string | undefined> = process.env,
): Promise<WebPushConfig> {
  const publicKey = validKey(environment.COFORGE_WEB_PUSH_PUBLIC_KEY, 65, "public");
  const privateKeyFile = environment.COFORGE_WEB_PUSH_PRIVATE_KEY_FILE?.trim();
  if (!privateKeyFile) throw new Error("COFORGE_WEB_PUSH_PRIVATE_KEY_FILE is required");
  const privateKey = validKey((await Bun.file(privateKeyFile).text()).trim(), 32, "private");
  assertVapidKeyPair(publicKey, privateKey);
  const subject = environment.COFORGE_WEB_PUSH_SUBJECT?.trim() || "https://coforge.cn";
  if (!subject.startsWith("https://") && !subject.startsWith("mailto:"))
    throw new Error("COFORGE_WEB_PUSH_SUBJECT must use https or mailto");
  return { subject, publicKey, privateKey };
}

export function readWebPushPublicKey(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  try {
    return validKey(environment.COFORGE_WEB_PUSH_PUBLIC_KEY, 65, "public");
  } catch {
    return null;
  }
}

function validKey(value: string | undefined, bytes: number, label: string) {
  const key = value?.trim();
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key) || Buffer.from(key, "base64url").byteLength !== bytes)
    throw new Error(`Web Push ${label} key is invalid`);
  return key;
}

export function createWebPushRequestDetails(
  config: WebPushConfig,
  subscription: StoredWebPushSubscription,
  payload: WebPushPayload,
) {
  return webPush.generateRequestDetails(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    JSON.stringify(payload),
    {
      TTL: 60 * 60,
      urgency: "normal",
      contentEncoding: "aes128gcm",
      vapidDetails: config,
    },
  );
}

const DEFAULT_TIMEOUT_MS = 10_000;

export type WebPushTransportDependencies = {
  timeoutMs?: number;
  resolveTarget?: typeof resolvePinnedWebPushTarget;
  sendRequest?: typeof sendPinnedWebPushRequest;
};

export class WebPushLibraryTransport implements WebPushTransport {
  private readonly timeoutMs: number;
  private readonly resolveTarget: typeof resolvePinnedWebPushTarget;
  private readonly sendRequest: typeof sendPinnedWebPushRequest;

  constructor(
    private readonly config: WebPushConfig,
    dependencies: WebPushTransportDependencies = {},
  ) {
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resolveTarget = dependencies.resolveTarget ?? resolvePinnedWebPushTarget;
    this.sendRequest = dependencies.sendRequest ?? sendPinnedWebPushRequest;
  }

  async send(subscription: StoredWebPushSubscription, payload: WebPushPayload) {
    try {
      const requestDetails = createWebPushRequestDetails(this.config, subscription, payload);
      const target = await this.resolveTarget(subscription.endpoint);
      const response = await this.sendRequest(requestDetails, target, this.timeoutMs);
      // Mirrors web-push 3.6.7's own success range (web-push-lib.js `sendNotification`).
      if (response.statusCode < 200 || response.statusCode > 299) {
        throw new WebPushDeliveryError(response.statusCode);
      }
    } catch (error) {
      if (error instanceof WebPushDeliveryError) throw error;
      throw new WebPushDeliveryError(undefined);
    }
  }
}
