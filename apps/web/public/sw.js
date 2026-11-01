/*
 * OpenCMO's service worker (P6 C1): web push only. A push carries no payload, so it says nothing by itself: the worker
 * asks the app how many cards wait (same origin, the founder's own session) and shows that. A tap opens the queue;
 * nothing is ever decided from a notification. No caching, no offline: the app stays exactly as it is without it.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let body = "Cards wait for your decision.";
      try {
        const res = await fetch("/api/v1/account", { credentials: "same-origin", cache: "no-store" });
        if (res.ok) {
          const json = await res.json();
          const n = Number((json && (json.data ? json.data.cmo_pending : json.cmo_pending)) || 0);
          if (n === 1) body = "1 card waits for your decision.";
          else if (n > 1) body = n + " cards wait for your decision.";
        }
      } catch (_) {
        // Signed out or offline: the generic line still opens the queue.
      }
      await self.registration.showNotification("Your CMO", { body, icon: "/icon.svg", tag: "opencmo-queue", renotify: true, data: { url: "/app" } });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/app", self.location.origin);
  // Only our own pages.
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of open) {
        if (new URL(client.url).origin === url.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url.href);
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
