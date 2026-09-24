import { m } from "#src/paraglide/messages";

export type StoredWebPushSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type WebPushSubscriptionInput = Omit<StoredWebPushSubscription, "id"> & {
  expirationTime: Date | null;
};

export type WebPushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  forceDisplay?: boolean;
};

/** One recipient of a message: their id, and every browser subscription they currently hold (which
 * may be none — a recipient with zero subscriptions still belongs here, for the in-page path). */
export type MessageRecipient = {
  userId: string;
  subscriptions: StoredWebPushSubscription[];
};

export type MessageWebPushNotification = {
  title: string;
  body: string;
  url: string;
  /** The message's Workspace, so the in-page publication can scope its event. */
  workspaceId: string;
  recipients: MessageRecipient[];
};

/** The `notificationForMessage` recipient rule, narrowed to one already-known recipient — the read
 * seam behind the browser's `getMessageNotification`. Never leaks whether a *different* user is a
 * recipient: a non-recipient and a non-existent message both resolve to `null`. */
export type RecipientNotification = {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** The un-anchored target (`/messages/channels/<id>` or `/messages/<agentId>`), so the browser can
   * compare it against the page it is already looking at before showing an OS notification. */
  conversationPath: string;
};

export interface WebPushSubscriptionStore {
  notificationForMessage(messageId: string): Promise<MessageWebPushNotification | null>;
  notificationForRecipient(
    messageId: string,
    userId: string,
  ): Promise<RecipientNotification | null>;
  subscriptionsForUser(userId: string): Promise<StoredWebPushSubscription[]>;
  saveSubscription(userId: string, subscription: WebPushSubscriptionInput): Promise<void>;
  removeSubscription(userId: string, endpoint: string): Promise<void>;
  removeSubscriptionById(id: string): Promise<void>;
}

export interface WebPushTransport {
  send(subscription: StoredWebPushSubscription, payload: WebPushPayload): Promise<void>;
}

export class WebPushDeliveryError extends Error {
  constructor(readonly statusCode?: number) {
    super("Web Push delivery failed");
    this.name = "WebPushDeliveryError";
  }
}

/** The one place `message:<id>` is spelled: the store's `notificationForRecipient` tag and the
 * push payload's own tag must always agree, so a later push replaces the in-page notification
 * instead of duplicating it. */
export function messageNotificationTag(messageId: string): string {
  return `message:${messageId}`;
}

/** Publishes the bodiless `notification.available.v1` in-page signal to every recipient's
 * own `chat:user:<user_id>` channel. Best-effort from `WebPushNotifications`' point of view: a
 * rejection is caught and logged, never thrown into the canonical send path. */
export type NotificationPublisher = {
  notifyRecipients(input: {
    messageId: string;
    workspaceId: string;
    userIds: readonly string[];
  }): Promise<void>;
};

type DeliveryResult = {
  sent: number;
  failed: number;
  removed: number;
  unreachable: number;
  errorId?: string;
};

type Locale = "en" | "zh-CN";

/** One correlated id per delivery batch, so a toast can quote what the log recorded. */
function deliveryErrorId() {
  return crypto.randomUUID();
}

/**
 * Classifies a `sendTest` result into the honest-error decision the Settings test button needs:
 * `"unreachable"` only when every attempted delivery failed because the push service
 * itself could not be reached (never a mix with an ordinary failure or a removed subscription —
 * either of those means the browser's own permission/subscription is the real story), `"failed"`
 * for any other zero-`sent` outcome, `"sent"` otherwise.
 */
export function classifyTestDelivery(result: DeliveryResult): "sent" | "failed" | "unreachable" {
  if (result.sent > 0) return "sent";
  if (result.removed === 0 && result.failed === 0 && result.unreachable > 0) return "unreachable";
  return "failed";
}

export class WebPushNotifications {
  constructor(
    private readonly subscriptions: WebPushSubscriptionStore,
    private readonly transport: WebPushTransport,
    private readonly publisher?: NotificationPublisher,
  ) {}

  subscribe(userId: string, subscription: WebPushSubscriptionInput) {
    return this.subscriptions.saveSubscription(userId, subscription);
  }

  unsubscribe(userId: string, endpoint: string) {
    return this.subscriptions.removeSubscription(userId, endpoint);
  }

  /**
   * One committed message's best-effort notification fan-out: Web Push delivery to every
   * recipient's browser subscriptions, and the in-page `notification.available.v1` publication to
   * every recipient — from the same `notificationForMessage` read, so the recipient rule is
   * evaluated once. Both run concurrently; a publication failure never affects the returned Web
   * Push delivery counts.
   */
  async notifyMessage(messageId: string): Promise<DeliveryResult> {
    const notification = await this.subscriptions.notificationForMessage(messageId);
    if (!notification) return { sent: 0, failed: 0, removed: 0, unreachable: 0 };
    const subscriptions = notification.recipients.flatMap((recipient) => recipient.subscriptions);
    const userIds = notification.recipients.map((recipient) => recipient.userId);
    const [delivery] = await Promise.all([
      this.deliver(subscriptions, {
        title: notification.title,
        body: notification.body,
        url: notification.url,
        tag: messageNotificationTag(messageId),
      }),
      this.publishAvailable(messageId, notification.workspaceId, userIds),
    ]);
    return delivery;
  }

  private async publishAvailable(
    messageId: string,
    workspaceId: string,
    userIds: readonly string[],
  ) {
    if (!this.publisher || userIds.length === 0) return;
    try {
      await this.publisher.notifyRecipients({ messageId, workspaceId, userIds });
    } catch {
      console.warn(JSON.stringify({ event: "in_page_notification.unavailable", messageId }));
    }
  }

  async sendTest(userId: string, endpoint: string, locale: Locale): Promise<DeliveryResult> {
    const subscriptions = (await this.subscriptions.subscriptionsForUser(userId)).filter(
      (subscription) => subscription.endpoint === endpoint,
    );
    return this.deliver(subscriptions, {
      title: m.preferences_browser_notifications_test_title({}, { locale }),
      body: m.preferences_browser_notifications_test_body({}, { locale }),
      url: "/settings",
      tag: `test:${crypto.randomUUID()}`,
      forceDisplay: true,
    });
  }

  private async deliver(
    subscriptions: StoredWebPushSubscription[],
    payload: WebPushPayload,
  ): Promise<DeliveryResult> {
    const errorId = deliveryErrorId();
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await this.transport.send(subscription, payload);
          return "sent" as const;
        } catch (error) {
          const statusCode = error instanceof WebPushDeliveryError ? error.statusCode : undefined;
          if (statusCode === 404 || statusCode === 410) {
            await this.subscriptions.removeSubscriptionById(subscription.id);
            console.error(
              JSON.stringify({
                event: "web_push.subscription_removed",
                errorId,
                subscriptionId: subscription.id,
                statusCode,
                outcome: "failed",
              }),
            );
            return "removed" as const;
          }
          // No status code means the transport never got a response at all (timeout, connection
          // refused, DNS failure, or an egress/encryption error it could not distinguish from one)
          // rather than the push service answering with a failure — the best signal available, not
          // a pure network classifier.
          const unreachable = error instanceof WebPushDeliveryError && statusCode === undefined;
          console.error(
            JSON.stringify({
              event: "web_push.delivery_failed",
              errorId,
              subscriptionId: subscription.id,
              statusCode,
              unreachable,
              outcome: "failed",
            }),
          );
          return unreachable ? ("unreachable" as const) : ("failed" as const);
        }
      }),
    );
    return {
      sent: results.filter((result) => result === "sent").length,
      failed: results.filter((result) => result === "failed").length,
      removed: results.filter((result) => result === "removed").length,
      unreachable: results.filter((result) => result === "unreachable").length,
      errorId: results.some((result) => result !== "sent") ? errorId : undefined,
    };
  }
}
