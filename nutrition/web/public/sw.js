/*
 * Service worker. Four jobs:
 *   1. Make the app shell available offline so the camera opens with no signal.
 *   2. Never cache API or Supabase calls.
 *   3. Best-effort background sync: wake up on reconnect and ask any open tab to
 *      flush the offline queue (src/lib/queue.ts). A service worker has no Supabase
 *      session of its own, so it cannot complete the upload itself - it can only ask.
 *      If no tab is open, nothing happens here; the queue still flushes the moment the
 *      app is next opened, via the foreground triggers in Capture.tsx.
 *   4. Web Push: the Shabbat prep and havdalah-reconciliation nudges (plan 10.2) have to
 *      reach the phone even with the app fully closed, which background sync cannot do -
 *      that is exactly what push exists for.
 */

const CACHE = "shell-v1";
const SHELL = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept anything that must be fresh or authenticated.
  if (
    event.request.method !== "GET" ||
    url.pathname.startsWith("/api/") ||
    url.hostname.endsWith("supabase.co")
  ) {
    return;
  }

  // Network-first with a cache fallback: fresh when online, still opens when not.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("/")))
  );
});

// ---------------------------------------------------------------------------
// Background sync (job 3 above)
// ---------------------------------------------------------------------------
self.addEventListener("sync", (event) => {
  if (event.tag !== "flush-queue") return;
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) client.postMessage({ type: "flush-queue" });
    })
  );
});

// ---------------------------------------------------------------------------
// Web Push (job 4 above). Sent by /api/cron/shabbat - see that route for the schedule
// (Friday prep ~3h before candles, havdalah+30min, +2h re-fire, Sunday 8am fallback).
// ---------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let payload = { title: "Nutrition Log", body: "", url: "/" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Malformed payload - still show a generic notification rather than silently drop it.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
      // Shabbat notifications must not nag: one alert per event, no vibration buzzing.
      silent: false,
      tag: payload.tag || undefined,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      const existing = clients.find((c) => new URL(c.url).pathname === new URL(url, self.location.origin).pathname);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
