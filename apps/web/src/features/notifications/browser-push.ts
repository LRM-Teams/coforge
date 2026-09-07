export type BrowserNotificationPermission = NotificationPermission | "unsupported";

export type SerializedBrowserPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

let lifecycleDisabled = false;

export function disableBrowserPushLifecycle() {
  lifecycleDisabled = true;
}

export function browserPushLifecycleEnabled() {
  return !lifecycleDisabled;
}

export function browserNotificationPermission(): BrowserNotificationPermission {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  )
    return "unsupported";
  return Notification.permission;
}

export function shouldShowAddToHomeScreenGuide() {
  const appleMobile =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return appleMobile && !window.matchMedia("(display-mode: standalone)").matches;
}

export async function ensureBrowserPushSubscription(
  publicKey: string,
): Promise<SerializedBrowserPushSubscription> {
  if (browserNotificationPermission() !== "granted")
    throw new Error("Browser notification permission is not granted");
  const registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const applicationServerKey = decodeBase64Url(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey.buffer,
  });
  if (!browserPushLifecycleEnabled()) {
    await subscription.unsubscribe();
    throw new Error("Browser Push registration stopped during sign out");
  }
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth)
    throw new Error("Browser returned an incomplete Push subscription");
  return {
    endpoint: value.endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}

export async function currentBrowserPushEndpoint() {
  if (browserNotificationPermission() === "unsupported") return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription())?.endpoint ?? null;
}

export async function unsubscribeCurrentBrowserPush(
  detach: (endpoint: string) => Promise<unknown>,
) {
  disableBrowserPushLifecycle();
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  try {
    if (subscription) await detach(subscription.endpoint);
  } finally {
    await subscription?.unsubscribe();
    const notifications = await registration.getNotifications();
    for (const notification of notifications) notification.close();
  }
}

function decodeBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function sameKey(existing: ArrayBuffer | null, expected: Uint8Array) {
  if (!existing) return false;
  const bytes = new Uint8Array(existing);
  return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
}
