self.addEventListener("push", (event) => {
  event.waitUntil(showPushNotification(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data?.url));
});

async function showPushNotification(event) {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  if (!validPayload(payload)) return;
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/logo.svg",
    tag: payload.tag,
    data: { url: payload.url },
  });
}

async function openNotificationTarget(url) {
  if (typeof url !== "string" || !url.startsWith("/")) return;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows[0];
  if (existing) {
    await existing.navigate(url);
    return existing.focus();
  }
  return self.clients.openWindow(url);
}

function validPayload(payload) {
  return (
    payload &&
    typeof payload.title === "string" &&
    typeof payload.body === "string" &&
    typeof payload.tag === "string" &&
    typeof payload.url === "string" &&
    payload.url.startsWith("/")
  );
}
