/**
 * Web Push subscription management (plan 10.2). This is what lets the havdalah
 * reconciliation nudge and the Friday prep reminder reach the phone with the app fully
 * closed - background sync (queue.ts) cannot do that, since it can only wake a service
 * worker that has no open tab to hand work to. Push is a real subscription the server
 * can address directly.
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Base64url (the format VAPID keys and push subscription keys use) to a byte array. */
function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export type SubscribeResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "no-vapid-key" | "error"; detail?: string };

/**
 * Request notification permission and register a push subscription for `userId`.
 * Safe to call repeatedly - `pushManager.subscribe()` returns the existing subscription
 * if one is already active rather than creating a duplicate.
 */
export async function subscribeToPush(userId: string): Promise<SubscribeResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!VAPID_PUBLIC_KEY) return { ok: false, reason: "no-vapid-key" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // TS's dom lib types applicationServerKey against ArrayBuffer specifically, not the
      // broader ArrayBufferLike a Uint8Array is generic over - the value itself is a
      // perfectly normal BufferSource at runtime.
      applicationServerKey: base64UrlToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });

    const json = subscription.toJSON();
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        endpoint: json.endpoint,
        keys: json.keys,
      }),
    });
    if (!res.ok) return { ok: false, reason: "error", detail: await res.text() };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Current subscription state, for the Settings-adjacent toggle to reflect reality. */
export async function isSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  return sub !== null;
}

export type UnsubscribeResult = { ok: true } | { ok: false; detail?: string };

/**
 * The other half of subscribeToPush - added because Settings previously had no way to
 * turn notifications back off once enabled. Unsubscribes the browser's own push
 * registration first, then removes the matching row server-side so the cron job stops
 * addressing this device.
 */
export async function unsubscribeFromPush(userId: string): Promise<UnsubscribeResult> {
  if (!pushSupported()) return { ok: true }; // nothing to unsubscribe from
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return { ok: true };

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();

    const res = await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, endpoint }),
    });
    if (!res.ok) return { ok: false, detail: await res.text() };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
