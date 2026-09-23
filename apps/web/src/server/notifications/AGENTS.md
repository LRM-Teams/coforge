# Notifications

These rules apply to `src/server/notifications/`.

- The recipient rule and the notification title, body, and URL are composed
  once on the server (`notificationForMessage`/`notificationForRecipient`,
  sharing one where-clause) and used by both Web Push and in-page
  notifications. The browser only decides whether to show a notification;
  it never recomposes recipients or text.
- `in-page-notification-publisher.server.ts` is only the Centrifugo
  `broadcast` adapter that `WebPushNotifications` publishes through.
