/*
 * Minimal service worker. Two jobs only:
 *   1. Make the app shell available offline so the camera opens with no signal.
 *   2. Never cache API or Supabase calls.
 *
 * The offline capture QUEUE is deliberately not here - it lives in IndexedDB via
 * src/lib/queue.ts, because the queue needs to survive a worker restart and be
 * readable from the UI to show pending state. Phase 2 wires background sync to it.
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
