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

export type MessageWebPushNotification = Omit<WebPushPayload, "tag"> & {
  subscriptions: StoredWebPushSubscription[];
};

export interface WebPushSubscriptionStore {
  notificationForMessage(messageId: string): Promise<MessageWebPushNotification | null>;
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

type DeliveryResult = { sent: number; failed: number; removed: number };

export class WebPushNotifications {
  constructor(
    private readonly subscriptions: WebPushSubscriptionStore,
    private readonly transport: WebPushTransport,
  ) {}

  subscribe(userId: string, subscription: WebPushSubscriptionInput) {
    return this.subscriptions.saveSubscription(userId, subscription);
  }

  unsubscribe(userId: string, endpoint: string) {
    return this.subscriptions.removeSubscription(userId, endpoint);
  }

  async notifyMessage(messageId: string): Promise<DeliveryResult> {
    const notification = await this.subscriptions.notificationForMessage(messageId);
    if (!notification) return { sent: 0, failed: 0, removed: 0 };
    return this.deliver(notification.subscriptions, {
      title: notification.title,
      body: notification.body,
      url: notification.url,
      tag: `message:${messageId}`,
    });
  }

  async sendTest(userId: string, endpoint: string): Promise<DeliveryResult> {
    const subscriptions = (await this.subscriptions.subscriptionsForUser(userId)).filter(
      (subscription) => subscription.endpoint === endpoint,
    );
    return this.deliver(subscriptions, {
      title: "CoForge",
      body: "Browser notifications are working on this device.",
      url: "/settings",
      tag: `test:${crypto.randomUUID()}`,
      forceDisplay: true,
    });
  }

  private async deliver(
    subscriptions: StoredWebPushSubscription[],
    payload: WebPushPayload,
  ): Promise<DeliveryResult> {
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await this.transport.send(subscription, payload);
          return "sent" as const;
        } catch (error) {
          if (
            error instanceof WebPushDeliveryError &&
            (error.statusCode === 404 || error.statusCode === 410)
          ) {
            await this.subscriptions.removeSubscriptionById(subscription.id);
            return "removed" as const;
          }
          console.warn(
            JSON.stringify({
              event: "web_push.delivery_failed",
              subscriptionId: subscription.id,
              statusCode: error instanceof WebPushDeliveryError ? error.statusCode : undefined,
            }),
          );
          return "failed" as const;
        }
      }),
    );
    return {
      sent: results.filter((result) => result === "sent").length,
      failed: results.filter((result) => result === "failed").length,
      removed: results.filter((result) => result === "removed").length,
    };
  }
}
