# ADR 0065: In-page notifications while CoForge is open

Status: Accepted
Date: 2026-09-23
Decided by: Frank

## Context

Verified 2026-09-23 from staging (Beijing): `fcm.googleapis.com` and `jmt17.google.com` time out;
`web.push.apple.com` (Safari) and Mozilla's push endpoint are reachable. Web Push (docs/architecture.md
"Web Push 通知") depends on the browser's own push service to relay the encrypted payload — for
Chrome that is Google's FCM, which mainland-China networks cannot reach, from either the server or
the client. Chrome users on those networks never receive a Web Push notification, no matter how
correctly the server sends it.

Worse, when every delivery attempt failed this way, Settings' "Send test notification" showed
"Check this browser's permission and try again" — false: the permission was granted, subscription
creation succeeded, and the server's own attempt to reach the push service was what failed. The
member had no way to learn the real reason or that Safari/Firefox would work.

## Decision

**A. In-page notifications.** While a CoForge tab is open, the page shows the OS notification
itself, sourced from the existing realtime connection instead of a push service. Web Push is
unchanged and still owns delivery once every tab is closed (`BrowserPushLifecycle`); this is an
additional path, not a replacement.

- **Recipient rule stays single-sourced, server side.** `PrismaWebPushSubscriptionStore` (renamed
  responsibility, same class) now answers two questions from one shared where-clause builder: which
  `{userId, subscriptions}[]` are recipients of a message (`notificationForMessage`, used by both
  Web Push delivery and the in-page publication), and whether one already-known user is a recipient
  (`notificationForRecipient(messageId, userId)`, the HTTPS read the browser calls after a realtime
  signal). A recipient with zero Web Push subscriptions is still a recipient for the in-page path —
  the old contract silently dropped them.
- **The realtime signal carries no text**, matching every other Centrifugo event
  (`docs/architecture.md`, "Standalone Centrifugo"): `notification.available.v1 { messageId,
  workspaceId }`, published only to the recipient's own `chat:user:<user_id>` channel (never a
  channel- or Workspace-wide fan-out, and never a second channel dimension — it rides the same
  channel `message.available.v1`'s DM fan-out already uses). The browser fetches title/body/url over
  authenticated HTTPS (`getMessageNotification`) before it can show anything, so a viewer who cannot
  see the message learns nothing from the signal itself.
- **One `notifyMessage(messageId)` call does both.** `WebPushNotifications` reads
  `notificationForMessage` once, then runs Web Push delivery and the in-page publication
  concurrently; a publication failure is logged (`in_page_notification.unavailable`) and never
  affects the returned Web Push delivery counts, matching the existing best-effort contract
  (`bestEffortMessageNotifier`: the whole call is fire-and-forget from the send path). Publishing to
  many recipient channels at once uses Centrifugo's `broadcast` server-API method
  (https://centrifugal.dev/docs/server/server_api#broadcast) instead of N sequential `publish` calls,
  idempotent per message (`notification:<messageId>`, which `broadcast` applies per channel).
- **Each path's misconfiguration degrades only that path.** `createWebPushNotifications` builds
  the in-page publisher and the Web Push transport independently: a missing/invalid VAPID key pair
  degrades only Web Push delivery (to an always-`failed` transport, logged as
  `web_push.unconfigured` each time notifications are composed), and a missing Centrifugo
  configuration drops only the in-page publication (logged through `toPublicServerError`). This
  matters for local development, where VAPID keys are often not configured at all.
- **Recovery replay.** `notification.available.v1` shares the `chat` namespace's bounded history
  with `message.available.v1`, so a DM now uses two history slots, and a tab that recovers after a
  short disconnect may show the notifications it missed in a short burst. Both are accepted.
- **Client.** `InPageNotifications` (`apps/web/src/features/notifications/`) subscribes
  `chat:user:<viewer_id>` and ignores any publication that does not decode as
  `notification.available.v1` (the channel also carries `message.available.v1`). On a valid event it
  checks the same enabled-preference and granted-permission gate `BrowserPushLifecycle` uses, fetches
  the notification, and skips showing it only while the tab is the visible, focused window already
  looking at that exact conversation (`shouldShowInPageNotification`, a pure function so this
  decision is unit-tested without a browser). It calls `ServiceWorkerRegistration.showNotification`
  (never the `Notification` constructor, which throws on mobile browsers per MDN) with the same
  `message:<id>` tag Web Push uses, so a later push replaces the in-page notification instead of
  duplicating it; clicks are already handled by the existing `service-worker.js`
  `notificationclick`.
- **Shared `chat:user:` subscription.** Two features now legitimately subscribe to the same
  `chat:user:<user_id>` channel on the shared connection (the sidebar's unread badges,
  `useChannelUnread`, and `InPageNotifications`) — Centrifuge's `newSubscription` throws if called
  twice for one channel on one client. `useRealtimeSubscription` (`features/realtime/browser-realtime.tsx`)
  now ref-counts one real `Subscription` per channel per client: the first caller creates and
  subscribes it, the last caller's cleanup unsubscribes and removes it, and each caller still only
  ever sees its own latest `onPublication`/`onSubscribed`/`onError` closure. This is the seam every
  future second subscriber to an already-subscribed channel now goes through automatically.

**B. The Settings test succeeds when the page can notify.** `WebPushNotifications`' delivery result
gains an `unreachable` count: a failure that is `WebPushDeliveryError` with no `statusCode` (the
transport never got a response — timeout, connection refused, DNS failure) is `unreachable` rather
than `failed`, and is logged with `unreachable: true` on `web_push.delivery_failed`. When every test
delivery failed that way, `sendTestBrowserNotification` throws the internal `PUSH_SERVICE_UNREACHABLE`
code and Settings shows the test notification from the page itself (`showPageNotification`), because
that is exactly how this member will receive notifications while CoForge is open. The member is not
told about push services or networks; the push-side failure stays in the server log. Any other
failure keeps the existing error copy.

## Rejected alternatives

**An overseas relay/proxy in front of FCM.** Would restore Web Push for every browser, but adds a
new operated service (its own availability, latency and cost) and is still useless for the actual
failure mode described here: Chrome clients (not just the CoForge server) in mainland China cannot
reach Google's push infrastructure either, so a server-side proxy alone does not fix delivery to the
browser.

**Putting message text in the realtime event.** Would let the browser show a notification without a
second round trip, but breaks the bodiless-event rule `docs/architecture.md` states for every
Centrifugo publication (`message.available.v1`, `member.changed.v1`) — content stays behind
authenticated HTTPS, never carried on the WSS transport.

## Consequences and migration

- Additive: one new realtime event type, one new HTTPS read (`getMessageNotification`), one new
  `AppError` code, and an `unreachable` field on an existing internal result type. No schema change,
  no wire-protocol change to Daemon/Agent contracts (`notification.available.v1` is Web-browser-only,
  never sent to a code-agent runtime).
- `docs/architecture.md`'s "Web Push 通知" section and the Standalone Centrifugo realtime section are
  updated in the same change to describe the in-page path and the new event.
- Rollback is the release: reverting the CR(s) removes the new event, read, and client subscription;
  Web Push itself is unchanged and keeps working exactly as before this ADR.

## Validation and rollback

- Unit tests: `test/web-push-notifications.test.ts` (recipients-with-empty-subscriptions, concurrent
  delivery+publish, publish-failure isolation, `unreachable` classification, `classifyTestDelivery`),
  `test/in-page-notification-publisher.test.ts` (broadcast shape, no-recipients no-op),
  `test/centrifugo-server-api.test.ts` (`broadcast`, including a partial-failure rejection),
  `test/conversation-realtime.test.ts` (`notification.available.v1` decoder, and that the existing
  `message.available.v1` decoder rejects it), `test/notifications-schemas.test.ts`
  (`messageNotificationInput`), `test/in-page-notifications.test.ts` (the pure show/enabled
  decisions), `test/web-push-composition.test.ts` (VAPID-misconfigured degrade path).
- `test/public-channel.integration.ts` (local PostgreSQL/Redis) exercises the refactored recipient
  rule end to end, including a recipient with zero push subscriptions; run with
  `CHANNEL_TEST_DATABASE_URL`/`CHANNEL_TEST_REDIS_URL` against a local Postgres. Two pre-existing
  failures in that suite (general-channel auto-enrollment assertions predating ADR 0061, which
  retired automatic `#general` enrollment) are unrelated to this change.
- `mise run test`, `mise run check`, `mise run build`.
